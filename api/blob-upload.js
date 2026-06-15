import { handleUpload } from '@vercel/blob/client';
import { requireAdminFromToken, json } from './_firebaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok:false, message:'Método não permitido.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const payload = clientPayload ? JSON.parse(clientPayload) : {};
        await requireAdminFromToken(payload.idToken);
        if (!payload.lessonId) throw new Error('Aula não informada para o upload.');
        return {
          allowedContentTypes: [
            'video/mp4',
            'video/webm',
            'video/quicktime',
            'video/x-matroska',
            'video/x-msvideo',
            'application/octet-stream'
          ],
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ lessonId: payload.lessonId })
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        console.log('Beta Cursos: vídeo enviado', blob.url, tokenPayload);
      }
    });
    return json(res, 200, jsonResponse);
  } catch (err) {
    return json(res, err.status || 400, { ok:false, message:err.message || 'Erro ao enviar vídeo.' });
  }
}
