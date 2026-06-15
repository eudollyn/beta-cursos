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
