# Beta Cursos — Vercel + Firebase + Vercel Blob

Esta versão mantém o visual em HTML/CSS/JS e troca o funcionamento local por serviços online:

- **Vercel**: hospedagem do site e APIs seguras.
- **Firebase Auth**: login de admin e aluno.
- **Cloud Firestore**: banco de dados de alunos, módulos, aulas e progresso.
- **Vercel Blob**: upload de vídeos pelo painel admin.

## 1. Firebase

No Firebase Console:

1. Ative **Authentication > Email/Password**.
2. Crie o **Cloud Firestore** em modo produção.
3. Publique as regras do arquivo `firestore.rules`.

### Primeiro admin

Como o painel só cadastra alunos depois que já existe um admin, crie o primeiro admin manualmente:

1. Firebase Console > Authentication > Users > Add user.
2. Cadastre o e-mail/senha do admin.
3. Copie o **UID** do usuário criado.
4. Firestore Database > coleção `users` > documento com ID igual ao UID.
5. Crie os campos:

```text
name: Nome do Admin
email: email-do-admin
phone: 
role: admin
status: ativo
```

## 2. Vercel Blob

No painel da Vercel:

1. Importe este projeto.
2. Vá em **Storage**.
3. Crie um **Blob Store**.
4. Conecte o Blob Store ao projeto.
5. A Vercel cria automaticamente a variável `BLOB_READ_WRITE_TOKEN`.

O upload de vídeos usa client upload com troca de token via `/api/blob-upload`, sem expor a chave do Blob no navegador.

## 3. Variáveis de ambiente na Vercel

No projeto da Vercel, em **Settings > Environment Variables**, adicione:

```text
FIREBASE_PROJECT_ID=beta-cursos-e93b7
FIREBASE_CLIENT_EMAIL=client_email_do_service_account
FIREBASE_PRIVATE_KEY=private_key_do_service_account
```

Para pegar isso:

1. Firebase Console > Project settings > Service accounts.
2. Clique em **Generate new private key**.
3. Abra o JSON baixado.
4. Copie:
   - `project_id` para `FIREBASE_PROJECT_ID`
   - `client_email` para `FIREBASE_CLIENT_EMAIL`
   - `private_key` para `FIREBASE_PRIVATE_KEY`

Na Vercel, cole a `private_key` inteira, incluindo:

```text
-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----
```

Se der erro de chave, substitua as quebras de linha por `\n`.

## 4. Deploy

Pelo painel da Vercel, basta importar o projeto e publicar.

Ou pelo terminal:

```cmd
npm install
npx vercel login
npx vercel --prod
```

## 5. URLs importantes

```text
/                 página inicial
/login.html       login
/plataforma.html  área do aluno
/admin.html       painel administrativo
```

## 6. Observações importantes

- O Firebase API Key no arquivo `public/assets/js/firebase-config.js` é pública por natureza; a segurança real fica nas regras do Firestore e nas APIs da Vercel.
- Os vídeos enviados pelo painel ficam no Vercel Blob e são vinculados à aula no Firestore.
- Esta versão usa Blob público. O aluno precisa estar logado para ver o link pela plataforma, mas alguém que obtiver a URL direta do vídeo pode tentar acessar. Para bloqueio total, seria necessário Blob privado com URL assinada por API.
- Para uso sem cobrança, acompanhe os limites gratuitos da Vercel e do Firebase.
