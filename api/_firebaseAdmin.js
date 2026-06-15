import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY
  ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
  : "";

if (!projectId) {
  throw new Error("FIREBASE_PROJECT_ID não configurado na Vercel.");
}

if (!clientEmail) {
  throw new Error("FIREBASE_CLIENT_EMAIL não configurado na Vercel.");
}

if (!privateKey) {
  throw new Error("FIREBASE_PRIVATE_KEY não configurado na Vercel.");
}

const app = getApps().length
  ? getApps()[0]
  : initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey
      })
    });

export const auth = getAuth(app);
export const db = getFirestore(app);

export function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.end(JSON.stringify(payload));
}

export async function requireAdminFromToken(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    const error = new Error("Token de autenticação ausente.");
    error.statusCode = 401;
    throw error;
  }

  const idToken = authHeader.replace("Bearer ", "").trim();

  const decoded = await auth.verifyIdToken(idToken);
  const userRef = db.collection("users").doc(decoded.uid);
  const userSnap = await userRef.get();

  if (!userSnap.exists) {
    const error = new Error("Usuário não encontrado no Firestore.");
    error.statusCode = 403;
    throw error;
  }

  const user = userSnap.data();

  if (user.status !== "ativo") {
    const error = new Error("Usuário bloqueado ou inativo.");
    error.statusCode = 403;
    throw error;
  }

  if (user.role !== "admin") {
    const error = new Error("Acesso administrativo negado.");
    error.statusCode = 403;
    throw error;
  }

  return {
    uid: decoded.uid,
    email: decoded.email,
    ...user
  };
}
