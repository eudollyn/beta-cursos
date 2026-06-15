import { handleUpload } from "@vercel/blob/client";
import { requireAdminByIdToken } from "./_firebaseAdmin.js";

export default async function handler(request) {
  if (request.method && request.method !== "POST") {
    return Response.json(
      { error: "Método não permitido." },
      { status: 405 }
    );
  }

  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error("BLOB_READ_WRITE_TOKEN não configurado na Vercel.");
    }

    const body = await request.json();

    const jsonResponse = await handleUpload({
      body,
      request,
      token: process.env.BLOB_READ_WRITE_TOKEN,

      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let payload = {};

        try {
          payload = clientPayload ? JSON.parse(clientPayload) : {};
        } catch {
          payload = {};
        }

        const idToken = payload.idToken || clientPayload;

        await requireAdminByIdToken(idToken);

        return {
          allowedContentTypes: [
            "video/mp4",
            "video/webm",
            "video/quicktime",
            "video/x-matroska",
            "video/avi"
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
      { status: error.statusCode || 400 }
    );
  }
}
