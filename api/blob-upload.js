import { handleUpload } from "@vercel/blob/client";
import { requireAdminByIdToken } from "./_firebaseAdmin.js";

export async function POST(request) {
  try {
    const body = await request.json();

    const jsonResponse = await handleUpload({
      body,
      request,

      ...(process.env.BLOB_READ_WRITE_TOKEN
        ? { token: process.env.BLOB_READ_WRITE_TOKEN }
        : {}),

      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let payload = {};

        try {
          payload = clientPayload ? JSON.parse(clientPayload) : {};
        } catch {
          payload = {};
        }

        const idToken = payload.idToken;

        await requireAdminByIdToken(idToken);

        return {
          allowedContentTypes: [
            "video/mp4",
            "video/webm",
            "video/quicktime",
            "video/x-matroska",
            "video/avi",
            "video/x-msvideo"
          ],
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({
            lessonId: payload.lessonId || "",
            pathname
          })
        };
      },

      onUploadCompleted: async ({ blob, tokenPayload }) => {
        console.log("Upload concluído:", {
          url: blob.url,
          pathname: blob.pathname,
          tokenPayload
        });
      }
    });

    return Response.json(jsonResponse);
  } catch (error) {
    console.error("BLOB_UPLOAD_ERROR:", error);

    return Response.json(
      {
        error: error.message || "Erro ao gerar token de upload.",
        code: error.code || null
      },
      {
        status: error.statusCode || 400
      }
    );
  }
}

export function GET() {
  return Response.json(
    {
      ok: true,
      route: "/api/blob-upload",
      message: "Rota de upload ativa. Use POST para enviar vídeos."
    },
    {
      status: 200
    }
  );
}
