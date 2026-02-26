import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Innertube, UniversalCache } from 'youtubei.js';

export const config = {
  maxDuration: 30,
  memory: 1024,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const videoId = req.query.v as string;
  if (!videoId || typeof videoId !== 'string' || videoId.length !== 11) {
    return res.status(400).json({
      error: '有効なYouTube video ID (?v=XXXXXXXXXXX) を指定してください'
    });
  }

  try {
const youtube = await Innertube.create({
  cache: new UniversalCache(false),
  generate_session_locally: false,  // ← これ重要！ trueだとPO Token生成が弱い
  retrieve_player: true,
  client_options: {  // クライアント情報を最新風に偽装
    client_name: 'ANDROID',
    client_version: '19.09.37',  // 2026年現在の有効なANDROIDバージョン例（古いと400）
    hl: 'ja',  // 言語（任意）
    gl: 'JP',  // 地域（任意）
  },
  // PO Tokenを手動で渡す場合（後述）
  // po_token: 'your_po_token_here',  // まだ自動生成不安定なのでブラウザから取得推奨
});

    const info = await youtube.getBasicInfo(videoId, { client: 'ANDROID' });  // ANDROIDでmuxed取りやすい傾向

    if (!info.streaming_data) {
      return res.status(503).json({
        error: 'ストリーミングデータが取得できませんでした（ライブ、地域制限、年齢制限など）'
      });
    }

    const allFormats = [
      ...(info.streaming_data.formats || []),
      ...(info.streaming_data.adaptive_formats || []),
    ];

    // mp4 muxed優先 → url直があれば最高画質、なければsignature_cipherの最高muxed
    let targetFormat = allFormats
      .filter(f => f.mime_type?.includes('video/mp4'))
      .filter(f => !!f.audio_quality)  // muxedのみ（音声あり）
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

    if (!targetFormat) {
      // muxedなければvideo-onlyの最高
      targetFormat = allFormats
        .filter(f => f.mime_type?.includes('video/mp4'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    }

    if (!targetFormat) {
      return res.status(404).json({
        error: '利用可能なmp4フォーマットが見つかりませんでした',
        available_mime_types: allFormats.map(f => f.mime_type),
      });
    }

    const responseBase = {
      success: true,
      video_id: videoId,
      itag: targetFormat.itag,
      mime_type: targetFormat.mime_type,
      quality_label: targetFormat.quality_label || 'unknown',
      bitrate: targetFormat.bitrate,
      approx_duration_ms: info.basic_info.duration
        ? Math.round(info.basic_info.duration * 1000)
        : null,
      player_js_url: info.player?.url ? `https://www.youtube.com${info.player.url}` : null,
    };

    if (targetFormat.url) {
      // 稀な直URLケース（まだ一部残っているかも）
      return res.status(200).json({
        ...responseBase,
        direct_url: true,
        url: targetFormat.url,
      });
    }

    if (targetFormat.signature_cipher) {
      const params = new URLSearchParams(targetFormat.signature_cipher);
      const base_url = params.get('url') || '';
      const sp = params.get('sp') || 'sig';  // 署名パラメータ名（sig または signature が多い）
      const s = params.get('s') || '';       // 暗号化署名

      return res.status(200).json({
        ...responseBase,
        needs_decipher: true,
        base_url,
        signature_param: sp,
        encrypted_signature: s,
      });
    }

    return res.status(500).json({ error: 'フォーマットにURLもsignature_cipherもありませんでした' });
} catch (err: any) {
  let detail = err.message || '不明';
  if (err.response) {
    try {
      detail = await err.response.text();  // 400のレスポンス本文（JSONエラー詳細）
    } catch {}
  }
  console.error('Innertube Error Details:', detail);
  return res.status(500).json({
    error: '処理中にエラーが発生しました',
    message: detail.slice(0, 500),  // Vercelログに残る
 　 });
　}
}
