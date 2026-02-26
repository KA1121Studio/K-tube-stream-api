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
      generate_session_locally: false,  // これをfalseにするとPO Tokenが付きやすくなる（400回避）
      retrieve_player: true,             // Player JSを取得（signature復号に必要）
      // client_options は存在しない → 削除
      // 代わりに client_type を指定（オプション）
      // client_type: 'ANDROID',  // コメントアウト推奨（WEBが安定する場合あり）
    });

    const info = await youtube.getBasicInfo(videoId);  // clientオプションを第2引数から削除（シンプルに）

    if (!info.streaming_data) {
      return res.status(503).json({
        error: 'ストリーミングデータが取得できませんでした（ライブ、地域制限、年齢制限など）'
      });
    }

    const allFormats = [
      ...(info.streaming_data.formats || []),
      ...(info.streaming_data.adaptive_formats || []),
    ];

    // mp4 muxed優先 → url直があれば最高、なければsignature_cipherのmuxed
    let targetFormat = allFormats
      .filter(f => f.mime_type?.includes('video/mp4') && !!f.audio_quality)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

    if (!targetFormat) {
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
      // player_js_url を youtube.player?.url から取得（retrieve_player: true で存在するはず）
      player_js_url: youtube.player?.url ? `https://www.youtube.com${youtube.player.url}` : null,
    };

    if (targetFormat.url) {
      return res.status(200).json({
        ...responseBase,
        direct_url: true,
        url: targetFormat.url,
      });
    }

    if (targetFormat.signature_cipher) {
      const params = new URLSearchParams(targetFormat.signature_cipher);
      const base_url = params.get('url') || '';
      const sp = params.get('sp') || 'sig';
      const s = params.get('s') || '';

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
        detail = await err.response.text();  // 400/503の詳細本文を取る
      } catch {}
    }
    console.error('エラー詳細:', detail);
    return res.status(500).json({
      error: '処理中にエラーが発生しました',
      message: detail.slice(0, 500),
    });
  }
}
