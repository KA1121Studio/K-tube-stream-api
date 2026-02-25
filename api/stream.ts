import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Innertube, UniversalCache } from 'youtubei.js';

export const config = {
  maxDuration: 30,           // Vercel無料枠だと60秒だが安全側に
  memory: 1024               // 必要に応じて増やす（128〜3008MB）
 };

async function getInfoWithFallback(youtube: Innertube, videoId: string) {
  const clients = ['ANDROID', 'WEB', 'TV', 'IOS'];

  for (const client of clients) {
    try {
      const info = await youtube.getBasicInfo(videoId, { client });
      if (info.streaming_data) {
        console.log(`Success with client: ${client}`);
        return info;
      }
    } catch (e) {
      console.log(`Failed with client: ${client}`);
    }
  }

  return null;
}

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
    // Innertube インスタンス（キャッシュ有効で高速化狙い）
    const youtube = await Innertube.create({
      cache: new UniversalCache(false), // メモリキャッシュ（Vercelではインスタンス単位）
      generate_session_locally: true,
      retrieve_player: true
    });

const info = await getInfoWithFallback(youtube, videoId);

if (!info) {
  return res.status(503).json({
    error: 'どのクライアントでもストリーミングデータを取得できませんでした'
  });
}
    
    if (!info.streaming_data) {
      return res.status(503).json({ 
        error: 'ストリーミングデータが取得できませんでした（ライブ、地域制限、年齢制限など）' 
      });
    }

    // 利用可能なフォーマットを結合
    const allFormats = [
      ...(info.streaming_data.formats || []),
      ...(info.streaming_data.adaptive_formats || [])
    ];

    // mp4コンテナで優先度高 → muxed（動画+音声） > video-only
    let targetFormat = allFormats
      .filter(f => f.mime_type?.includes('video/mp4'))
      .sort((a, b) => {
        const aHasAudio = !!a.audio_quality;
        const bHasAudio = !!b.audio_quality;
        if (aHasAudio !== bHasAudio) return aHasAudio ? -1 : 1;
        return (b.bitrate || 0) - (a.bitrate || 0);
      })[0];

    // muxedが見つからなければ最高画質のvideo/mp4
    if (!targetFormat) {
      targetFormat = allFormats
        .filter(f => f.mime_type?.includes('video/mp4'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    }

    if (!targetFormat) {
      return res.status(404).json({ 
        error: '利用可能なmp4フォーマットが見つかりませんでした',
        available_mime_types: allFormats.map(f => f.mime_type)
      });
    }

    // URLが直接取れるケース（最近は減っている）
    if (targetFormat.url) {
      return res.status(200).json({
        success: true,
        video_id: videoId,
        itag: targetFormat.itag,
        url: targetFormat.url,
        mime_type: targetFormat.mime_type,
        quality_label: targetFormat.quality_label || 'audio-only or unknown',
        bitrate: targetFormat.bitrate,
        approx_duration_ms: info.basic_info.duration 
          ? Math.round(info.basic_info.duration * 1000) 
          : null,
        expires_in: targetFormat.url.includes('expire=') 
          ? parseInt(targetFormat.url.match(/expire=(\d+)/)?.[1] || '0') * 1000 - Date.now()
          : null
      });
    }

    // signatureCipher しかない場合（2025〜2026年はこれが多い）
    if (targetFormat.signature_cipher) {
      return res.status(503).json({
        error: '署名付きURL (signature_cipher) のみ取得可能。クライアント側での復号が必要です。',
        itag: targetFormat.itag,
        signature_cipher: targetFormat.signature_cipher,
        mime_type: targetFormat.mime_type,
        quality_label: targetFormat.quality_label,
        bitrate: targetFormat.bitrate
      });
    }

    return res.status(500).json({ error: 'フォーマットにURLもsignature_cipherもありませんでした' });

  } catch (err: any) {
    console.error(err);
    return res.status(500).json({
      error: '処理中にエラーが発生しました',
      message: err.message?.slice(0, 300) || '不明なエラー'
    });
  }
}
