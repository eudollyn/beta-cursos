import { auth, db, json, requireAdminFromToken } from "./_firebaseAdmin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, {
      error: "Método não permitido."
    });
  }

  try {
    await requireAdminFromToken(req);

    const body = req.body || {};
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    const password = String(body.password || "").trim();

    if (!name) {
      return json(res, 400, {
        error: "Informe o nome do aluno."
      });
    }

    if (!email) {
      return json(res, 400, {
        error: "Informe o e-mail do aluno."
      });
    }

    if (!password || password.length < 6) {
      return json(res, 400, {
        error: "A senha precisa ter pelo menos 6 caracteres."
      });
    }

    let createdUser;

    try {
      createdUser = await auth.createUser({
        displayName: name,
        email,
        password,
        disabled: false
      });
    } catch (error) {
      if (error.code === "auth/email-already-exists") {
        return json(res, 400, {
          error: "Já existe um usuário cadastrado com este e-mail."
        });
      }

      throw error;
    }

    await db.collection("users").doc(createdUser.uid).set({
      name,
      email,
      phone,
      role: "aluno",
      status: "ativo",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    return json(res, 200, {
      ok: true,
      uid: createdUser.uid,
      email,
      password
    });
  } catch (error) {
    console.error("CREATE_USER_ERROR:", error);

    return json(res, error.statusCode || 500, {
      error: error.message || "Erro ao criar aluno.",
      code: error.code || null
    });
  }
}
