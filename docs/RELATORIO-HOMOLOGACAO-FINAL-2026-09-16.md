# Beta Cursos — relatório de homologação final

**Data:** 16 de setembro de 2026  
**Ambiente validado:** Railway — `web-production-2c5fa.up.railway.app`  
**Código local analisado:** `beta-cursos-recuperado-railway-2026-09-15`  
**Objetivo:** entregar uma evidência técnica e funcional para revisão independente antes da liberação definitiva.

**Pacote entregue ao revisor:** `beta-cursos-candidato-revisao-2026-09-16.tar.gz`

## Parecer executivo

**Resultado: APROVADO PARA REVISÃO TÉCNICA. AINDA NÃO APROVADO PARA PRODUÇÃO DEFINITIVA.**

A versão publicada está funcional para homologação. A suíte automatizada passou integralmente, o painel administrativo abriu diretamente sem reproduzir o erro antigo, as principais áreas carregaram dados reais e o fluxo de pagamento de teste foi concluído com sucesso pelo responsável pelo projeto após a inclusão de `MERCADO_PAGO_ACCESS_TOKEN_TEST` no Railway.

Antes da abertura ao público, ainda existem gates obrigatórios: revisão jurídica, rotação dos segredos já compartilhados durante o desenvolvimento, infraestrutura definitiva de dados/arquivos, auditoria de dependências executada em CI e rastreabilidade do código por repositório/tag.

## Evidências coletadas

### 1. Build e testes automatizados

Comando executado:

```text
npm test
```

Resultado:

- build gerado com sucesso em `dist/`;
- validação sintática de todos os arquivos públicos e do servidor concluída;
- **155 testes executados**;
- **155 aprovados**;
- **0 falhas, 0 ignorados e 0 pendentes**.

A suíte cobre, entre outros pontos:

- cadastro com idade mínima de 16 anos;
- confirmação de e-mail e recuperação de senha;
- sessão, logout, rate limiting e mensagens de autenticação sem enumeração de contas;
- papéis de proprietário, administrador, facilitador e aluno;
- criação, publicação e validação de cursos;
- lições com PDF, vídeo ou avaliação opcionais;
- pré-requisitos, fases e acessos excepcionais;
- acompanhamento de vídeo, progresso, quiz e desbloqueio de lições;
- upload, limites de arquivo e armazenamento;
- backup integral e proteção por autorização;
- Checkout Pro/Orders, idempotência, consulta de pedido e matrícula;
- assinatura do webhook do Mercado Pago;
- rollback em falhas de matrícula/progresso;
- SQLite, PostgreSQL e migrations concorrentes;
- configuração Railway, cookies seguros e e-mail via Resend;
- LGPD, cookies e ausência de dados privados no build público.

### 2. Homologação na versão publicada

Validações realizadas em sessão autenticada, sem alterar cursos, contas ou permissões:

| Área | Resultado | Evidência observada |
|---|---|---|
| Página inicial | PASSOU | Identidade geral de formação e discipulado, CTAs, FAQ e rodapé legal carregados |
| Catálogo público | PASSOU | Somente 2 cursos publicados exibidos; rascunhos permaneceram ocultos |
| Detalhes de curso | PASSOU | Descrição, contribuição, conteúdo e ação de inscrição carregados |
| Painel do aluno | PASSOU | Curso inscrito, 80% de progresso e continuidade da lição exibidos |
| Player | PASSOU | Vídeo do YouTube renderizado; último ponto e percentual assistido preservados |
| Administração direta | PASSOU | `#admin` abriu a Visão geral já carregada, sem exigir trocar de seção |
| Cursos | PASSOU | 4 cursos: 2 publicados, 2 rascunhos; 48 lições |
| Conteúdo opcional | PASSOU | Cursos sem questões aparecem como prontos quando os demais requisitos configurados são válidos |
| Preço | PASSOU | Jornada Lidere exibida por R$ 19,90 |
| Mídia | PASSOU | 13 arquivos listados e links protegidos disponíveis |
| Alunos | PASSOU | Matrículas, progresso, situação e última atividade carregados |
| Equipe | PASSOU | Proprietário, administrador e aluno exibidos com funções distintas |
| Exportações e segurança | PASSOU | Backup integral, exportação/importação do catálogo e avisos de confidencialidade disponíveis |
| Política de Privacidade | PASSOU COM PENDÊNCIA | Conteúdo acessível, dados institucionais e idade mínima corretos; ainda marcada como minuta |
| Termos de Uso | PASSOU COM PENDÊNCIA | Conteúdo acessível; ainda marcado como minuta |
| Política de Cookies | PASSOU COM PENDÊNCIA | Conteúdo acessível e coerente com uso atual; ainda marcada como minuta |

### 3. Pagamento de teste

Evidências disponíveis:

- o responsável pelo projeto concluiu uma compra de teste com sucesso;
- o problema anterior foi identificado corretamente como ausência de `MERCADO_PAGO_ACCESS_TOKEN_TEST` nas variáveis do Railway;
- o Railway agora mostra, de forma mascarada, o token de teste e a assinatura de webhook de teste configurados;
- a interface administrativa mostra matrícula ativa no curso pago, consistente com a conclusão do fluxo;
- testes automatizados validam criação da order, consulta, idempotência, assinatura do webhook e liberação da matrícula.

Limitação da evidência: os logs específicos da transação não estavam disponíveis no recorte consultado após o novo deploy. A aprovação externa deve repetir uma compra de homologação e preservar os IDs e logs de checkout/webhook como evidência auditável.

### 4. Serviço e configuração

O Railway mostrou o serviço como **Online** e os registros recentes confirmaram:

- ambiente `staging`;
- banco `sqlite`;
- armazenamento `filesystem`;
- Resend configurado e em estado `ready`;
- inicialização do servidor concluída;
- página, assets, sessão e APIs administrativas respondendo com HTTP 200;
- único 404 observado: pedido automático do navegador por `/favicon.ico`; o favicon principal em PNG respondeu normalmente.

O código configura healthcheck em `/health/ready`, política de reinício, drenagem de conexões, CSP, `nosniff`, `Referrer-Policy`, `Permissions-Policy` e isolamento de origem.

### 5. Segredos e dependências

- varredura do código, excluindo dependências e artefatos gerados, não encontrou tokens reais ou chaves com padrões conhecidos;
- somente `.env.example` existe na raiz analisada;
- credenciais publicadas no Railway permanecem mascaradas;
- árvore de produção contém 143 pacotes, com dependências diretas `@aws-sdk/client-s3@3.1087.0` e `pg@8.22.0`;
- `pnpm audit --prod` não conseguiu consultar o registro npm nesta estação por falha local de credenciais TLS/rede. Portanto, a auditoria de vulnerabilidades **não está concluída** e precisa ser executada no CI ou na máquina do revisor.

## Gates obrigatórios antes da produção

### P0 — bloqueiam a liberação

1. **Revisão jurídica:** Política de Privacidade, Termos de Uso e Política de Cookies ainda informam “Minuta em revisão jurídica”. Receber aprovação formal e publicar a versão/data aprovadas.
2. **Rotação de segredos:** gerar novos tokens de produção e teste do Mercado Pago, novas assinaturas de webhook e nova chave do Resend, pois credenciais foram compartilhadas durante o desenvolvimento. Cadastrar somente em variáveis protegidas do ambiente.
3. **Dados definitivos:** migrar SQLite para PostgreSQL e os arquivos do volume local para armazenamento de objetos durável, ou obter aceite técnico formal para continuar temporariamente no volume com backup e restauração comprovados.
4. **Separação de ambientes:** manter homologação com credenciais de teste e criar produção separada com `APP_ENV=production`, credenciais de produção, webhook de produção e domínio final.
5. **Rastreabilidade:** colocar o código em repositório privado, registrar o commit revisado e criar uma tag/release. A pasta atual não contém metadados Git; sem isso não é possível provar que o código aprovado é exatamente o código publicado.
6. **Auditoria de dependências:** executar `pnpm audit --prod` em ambiente com acesso ao registro e tratar qualquer alerta alto ou crítico.

### P1 — concluir na homologação final

1. Fazer uma compra de homologação completa e guardar: ID interno do checkout, ID da order, retorno aprovado, webhook HTTP 200 e matrícula liberada.
2. Executar e documentar um teste de restauração do backup integral, não apenas o download.
3. Testar cadastro, confirmação de e-mail e recuperação de senha em caixas de e-mail externas reais.
4. Validar o site em telefone Android e iPhone, incluindo menu, catálogo, checkout, player e painel administrativo. O código contém breakpoints responsivos, mas a emulação desta sessão não aplicou o viewport solicitado.
5. Remover arquivos duplicados da biblioteca de mídia quando for seguro; foram observados PDFs e imagens repetidos.
6. Definir o domínio final, DNS e remetente de e-mail definitivo.
7. Revisar quais cursos devem estar publicados no lançamento. No momento, Jornada Lidere permanece como rascunho.

## Checklist para o revisor independente

- [ ] Receber URL do ambiente de homologação e uma conta de cada papel.
- [ ] Comparar o hash/commit do pacote revisado com o deploy.
- [ ] Rodar `pnpm install --frozen-lockfile`, `pnpm test` e `pnpm audit --prod`.
- [ ] Revisar autenticação, autorização por papel e endpoints administrativos.
- [ ] Repetir checkout de teste e conferir webhook, order e matrícula no banco.
- [ ] Conferir que o cliente nunca recebe gabaritos, tokens ou dados de outros alunos.
- [ ] Validar backup e restauração.
- [ ] Validar PostgreSQL e armazenamento de objetos no ambiente espelho.
- [ ] Conferir documentos jurídicos aprovados e idade mínima de 16 anos.
- [ ] Testar celular, acessibilidade por teclado e navegadores principais.
- [ ] Autorizar por escrito o go-live ou listar correções obrigatórias.

## Comandos de reprodução

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm audit --prod
```

## Observação sobre reprodutibilidade do container

O `Dockerfile` atual copia apenas `package.json` na etapa de dependências e executa `pnpm install --no-frozen-lockfile`. Antes da produção, ele deve copiar também `pnpm-lock.yaml` e usar `pnpm install --frozen-lockfile`, para que o revisor e o Railway instalem exatamente as mesmas versões transitivas.

## Conclusão

A plataforma passou na homologação funcional e automatizada disponível e está pronta para ser entregue a uma pessoa técnica para a revisão de liberação. O próximo marco não é adicionar novas telas: é fechar os gates de segurança, jurídico, infraestrutura, rastreabilidade e operação descritos neste relatório.
