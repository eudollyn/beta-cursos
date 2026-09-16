# Beta Cursos — Auditoria técnica para decisão de produção

**Data:** 16 de setembro de 2026  
**Escopo:** revisão estática profunda, testes locais não destrutivos e comparação com o relatório de homologação.  
**Código auditado:** pacote `beta-cursos-recuperado-railway-2026-09-15`.  
**Ambiente Railway, banco, bucket, variáveis, e-mails e pagamentos reais:** **NÃO VERIFICADOS**. Esta auditoria não alterou código, dados, configurações nem fez deploy.

## Parecer executivo

**NO-GO para produção aberta ao público.**

O projeto tem uma base boa: autenticação server-side, senhas com `scrypt`, sessões opacas, validação de origem, autorização por papel, proteção de mídia, migrations transacionais, validação de assinatura do webhook e testes automatizados relevantes. Porém há bloqueadores objetivos para uma operação definitiva: documentos jurídicos ainda estão como minuta, o pacote não possui rastreabilidade Git, não existe ferramenta de restauração/migração de dados SQLite para PostgreSQL, e a integração de pagamentos mantém acesso ao curso após estorno ou chargeback. Também há um bypass comprovável de conclusão de vídeo por API e uma diferença material entre funcionalidades documentadas e as realmente implementadas.

O parecer pode mudar para **GO condicionado** após o fechamento dos itens P0/P1 e a execução da homologação final em uma infraestrutura de produção separada.

## Métodos e evidências

- Leitura de todos os arquivos de aplicação, configuração, migrations, testes e documentação operacional solicitados; artefatos ignorados conforme escopo (`node_modules`, `dist`, `.data`, cache e patches).
- `npm test` executado localmente: build, verificação sintática e **155 testes aprovados; 0 falhas, 0 ignorados**.
- `pnpm audit --prod` foi tentado, mas não concluiu: o acesso ao endpoint de advisories do registro npm retornou erro de permissão/rede nesta estação. Portanto, vulnerabilidades conhecidas de dependências são **NÃO VERIFICADAS**.
- Não foram realizadas compras, chamadas para contas externas, envios de e-mail, acesso autenticado ao Railway ou alterações de dados.

## Achados

### P0-01 — Não há uma versão auditável e rastreável para aprovar

**Arquivo/linha:** raiz do pacote (metadados `.git` ausentes); [RELATORIO-HOMOLOGACAO-FINAL-2026-09-16.md:122](RELATORIO-HOMOLOGACAO-FINAL-2026-09-16.md:122)  
**Evidência:** o diretório submetido não possui repositório Git, commit ou tag. O próprio relatório reconhece que não é possível provar que o código aprovado é exatamente o publicado.  
**Risco:** uma revisão pode aprovar um pacote e o Railway executar outro. Não é possível fazer rollback seguro nem investigar incidentes por versão.  
**Cenário:** uma correção local ou upload manual substitui arquivos no serviço sem identificação verificável; após uma falha de pagamento ou dados, não há como identificar o artefato executado.  
**Correção:** criar repositório privado, importar este código, remover qualquer segredo do histórico, criar commit inicial assinado/tag de release e configurar deploy somente desse repositório. Registrar SHA do commit, imagem Docker e migrations em cada release.  
**Teste de comprovação:** gerar build no CI a partir da tag e comparar o SHA/artefato com o deploy do Railway.

### P0-02 — Políticas legais ainda afirmam ser minuta

**Arquivo/linha:** [index.html:231](../index.html:231), [index.html:233](../index.html:233), [index.html:238](../index.html:238)  
**Evidência:** a Política de Privacidade mostra versão, data e o aviso “Minuta em revisão jurídica”. A homologação também registra a mesma pendência.  
**Risco:** abertura pública com termos, privacidade e cookies não aprovados formalmente, apesar de o sistema tratar dados pessoais, progresso e pagamentos.  
**Cenário:** titular solicita exclusão, retenção ou informação de compartilhamento e a igreja não possui política final aprovada nem procedimento formal correspondente.  
**Correção:** revisão jurídica, aprovação por responsável definido, publicação da versão/data final e alinhamento da operação com o texto aprovado (retenção, canal de direitos, fornecedores e transferências internacionais).  
**Teste de comprovação:** revisão jurídica documentada e checklist de conteúdo publicado comparado à configuração real de hospedagem, e-mail, pagamentos e vídeo.

### P1-01 — Estorno, refund e chargeback não revogam matrícula já concedida

**Arquivo/linha:** [railway/application-api.mjs:2840](../railway/application-api.mjs:2840)-[2875](../railway/application-api.mjs:2875)  
**Evidência:** o status remoto é atualizado para qualquer resultado, mas `ensureEnrollment(...)` é chamado somente quando `nextStatus === 'approved'`. Não há desativação da matrícula quando o status passa para `refunded`, `charged_back`, `cancelled` ou `rejected`.  
**Risco:** aluno com pagamento estornado ou contestado mantém acesso ativo ao curso pago.  
**Cenário:** o Mercado Pago notifica um chargeback de uma order antes aprovada; o checkout fica marcado como chargeback, mas a linha em `app_enrollments` continua `active`, e o servidor de mídia continua liberando material.  
**Correção:** definir política de negócio para estorno/contestação e, ao receber status terminal não aprovado, suspender a matrícula vinculada ao checkout de forma transacional; preservar histórico/auditoria e prever exceção pastoral explícita. Não revogar automaticamente casos que tenham política diferente sem registrar a decisão.  
**Teste de comprovação:** criar matrícula por order aprovada, simular webhook assinado de `refunded` e `charged_back`, confirmar acesso negado à API/mídia e confirmar que uma reaprovação legítima restaura acesso sem duplicar matrícula.

### P1-02 — Progresso de vídeo pode ser marcado como concluído sem o rastreamento do player

**Arquivo/linha:** [railway/application-api.mjs:1836](../railway/application-api.mjs:1836)-[1848](../railway/application-api.mjs:1848), [railway/application-api.mjs:1992](../railway/application-api.mjs:1992)-[2031](../railway/application-api.mjs:2031)  
**Evidência:** a rota de sincronização aceita `proposed.videoCompleted === true` e grava a transição. Ela não consulta `app_video_progress`; a rota específica de vídeo existe, mas não é a autoridade usada nessa decisão.  
**Risco:** um aluno matriculado pode chamar a API de progresso em vez do player, desbloquear prova/lição seguinte e obter conclusão acadêmica sem assistir ao vídeo.  
**Cenário:** após marcar a apostila como lida quando aplicável, o navegador ou script envia uma atualização de progresso com `videoCompleted:true`; em uma segunda chamada marca a lição como concluída, ou libera o quiz.  
**Correção:** tornar `app_video_progress` a fonte de verdade: somente o endpoint de vídeo deve determinar conclusão após duração/trechos/`ended` válidos; `synchronizeProgress` deve ignorar ou rejeitar `videoCompleted` vindo do cliente. Se a igreja decidir que o botão manual é aceitável, remover a promessa de rastreamento real e não usá-lo para certificados/pré-requisitos.  
**Teste de comprovação:** teste de API que envie diretamente `videoCompleted:true` sem eventos de player e receba `409`; testar conclusão real por vídeo, progresso concorrente e conteúdo apenas PDF/vídeo/quiz.

### P1-03 — Não há mecanismo implementado para restaurar backup integral nem migrar dados existentes de SQLite para PostgreSQL

**Arquivo/linha:** [railway/full-backup.mjs:94](../railway/full-backup.mjs:94)-[120](../railway/full-backup.mjs:120), [railway/migrate.mjs:90](../railway/migrate.mjs:90)-[99](../railway/migrate.mjs:99)  
**Evidência:** o backup gera um arquivo NDJSON compactado com tabelas e bytes de mídia. Não há leitor/restaurador no projeto. `migrate.mjs` apenas cria esquema e aplica SQL; não exporta nem importa dados de SQLite. Os testes de backup verificam somente a geração e a falha por mídia ausente, não uma restauração.  
**Risco:** não existe recuperação reproduzível após incidente e a migração para a infraestrutura definitiva pode deixar usuários, matrículas, progresso, pagamentos ou arquivos para trás.  
**Cenário:** após popular a homologação em SQLite, a equipe cria PostgreSQL/bucket, aplica migrations e aponta a aplicação ao novo banco; o novo ambiente inicia vazio porque nenhuma rotina transfere dados e mídias.  
**Correção:** implementar ferramenta administrativa de migração/restore separada, com modo dry-run, validação de schema, transação por lote, mapa de chaves, checksum de mídias, idempotência, relatório de contagens e bloqueio explícito contra sobrescrita acidental. Definir backup agendado, criptografado, retenção e procedimento de restore em ambiente isolado.  
**Teste de comprovação:** restaurar um backup representativo em PostgreSQL e bucket de staging, comparar contagens/chaves/hash de arquivos, autenticar usuários, abrir mídia, consultar pagamentos/progresso e ensaiar rollback.

### P1-04 — Fases pastorais e liberações excepcionais são declaradas como existentes, mas não estão no modelo nem nas rotas revisadas

**Arquivo/linha:** [railway/application-api.mjs:1370](../railway/application-api.mjs:1370)-[1385](../railway/application-api.mjs:1385), [RELATORIO-HOMOLOGACAO-FINAL-2026-09-16.md:44](RELATORIO-HOMOLOGACAO-FINAL-2026-09-16.md:44)  
**Evidência:** o `accessPolicy` aceito pelo backend contém somente `open/restricted`, IDs de cursos pré-requisito e visibilidade de catálogo. A busca em fontes, schema, migrations e testes encontrou categorias (`Alcançar`, `Adorar`, etc.) e pré-requisitos, mas nenhuma entidade/endpoint/regra de fase individual ou autorização excepcional por aluno. O relatório afirma que a suíte cobre “fases e acessos excepcionais”.  
**Risco:** liderança pode acreditar que cursos são liberados por fase pastoral ou exceção individual quando, na prática, só há pré-requisito de curso concluído.  
**Cenário:** um administrador classifica um curso em “Engajar” esperando bloquear alunos de outras fases; qualquer conta com pré-requisitos satisfeitos pode se inscrever.  
**Correção:** corrigir a documentação imediatamente. Antes de prometer a regra à igreja, modelar fases, vínculo de fase por aluno, exceções por curso, ator/justificativa/data de expiração e uma matriz de decisão testada no servidor. Caso a decisão pastoral seja adiar, remover essas alegações e tratar categorias apenas como organização do catálogo.  
**Teste de comprovação:** testes de tabela de decisão cobrindo fase atual/anterior, curso aberto, pré-requisito, exceção válida/expirada, alteração de fase, auditoria e bloqueio da API de checkout/mídia.

### P1-05 — O Dockerfile não usa o lockfile para instalar dependências

**Arquivo/linha:** [Dockerfile:12](../Dockerfile:12)-[16](../Dockerfile:16)  
**Evidência:** a etapa de dependências copia apenas `package.json` e executa `pnpm install --no-frozen-lockfile`; `pnpm-lock.yaml` não é copiado nem exigido.  
**Risco:** uma imagem criada hoje pode resolver versões transitivas diferentes da analisada/testada, incluindo alteração incompatível ou vulnerável.  
**Cenário:** o Railway recompila após uma alteração sem dependências diretas e recebe uma árvore transitiva mais nova que a usada nos 155 testes.  
**Correção:** copiar `package.json` e `pnpm-lock.yaml` antes da instalação e usar `pnpm install --frozen-lockfile`; em CI, falhar se o lock divergir. Fixar também a imagem base por digest para reprodutibilidade mais forte.  
**Teste de comprovação:** duas imagens construídas da mesma tag devem produzir a mesma árvore `pnpm list --prod` e o build deve falhar quando o lock estiver inconsistente.

### P1-06 — Produção PostgreSQL/S3 e a configuração publicada não foram comprovadas por testes reais

**Arquivo/linha:** [tests/railway-migrate.test.mjs:29](../tests/railway-migrate.test.mjs:29)-[64](../tests/railway-migrate.test.mjs:64), [tests/railway-config.test.mjs:55](../tests/railway-config.test.mjs:55)-[93](../tests/railway-config.test.mjs:93)  
**Evidência:** os testes de migration PostgreSQL usam uma conexão simulada que apenas registra SQL; os de S3/produção validam parsing de variáveis. Não há suíte contra PostgreSQL real, bucket real, domínio final, Resend real ou conta Mercado Pago de produção. O ambiente Railway atual não foi acessado nesta auditoria.  
**Risco:** uma diferença de SQL, permissões IAM, endpoint S3, SSL, DNS, domínio de e-mail ou variável pode impedir a inicialização ou quebrar dados no primeiro deploy definitivo.  
**Cenário:** a migration inicia em PostgreSQL real e falha por incompatibilidade não simulada; ou o bucket nega `ListObjects` no readiness e a aplicação não sobe.  
**Correção:** criar staging espelho com PostgreSQL e bucket privados reais, e CI com serviços efêmeros ou containers para PostgreSQL. Fazer a virada a produção somente após checklist de infraestrutura e backup/restore.  
**Teste de comprovação:** executar migrations, CRUD, upload/download protegido, backup/restore, login/e-mail e checkout de teste contra os serviços reais de staging; guardar logs e IDs mascarados.

### P2-01 — Rate limiting de autenticação é somente em memória do processo

**Arquivo/linha:** [railway/application-api.mjs:16](../railway/application-api.mjs:16)-[18](../railway/application-api.mjs:18), [railway/application-api.mjs:627](../railway/application-api.mjs:627)-[665](../railway/application-api.mjs:665)  
**Evidência:** os buckets de IP/e-mail estão em um `Map` no processo Node.  
**Risco:** reinício, novo deploy ou múltiplas réplicas zeram/separam a contagem, reduzindo a proteção contra força bruta e spam.  
**Cenário:** um atacante alterna réplicas ou aguarda um restart para repetir tentativas de login/recuperação sem atingir o limite global.  
**Correção:** aplicar limite no edge/WAF e/ou usar armazenamento compartilhado com TTL (Redis, por exemplo), mantendo proteção por IP e e-mail.  
**Teste de comprovação:** enviar tentativas distribuídas entre duas instâncias/restart e confirmar bloqueio compartilhado, expiração e logs sem e-mail/IP em claro.

### P2-02 — Readiness não verifica entrega real de e-mail

**Arquivo/linha:** [railway/server.mjs:318](../railway/server.mjs:318)-[363](../railway/server.mjs:363), [railway/server.mjs:430](../railway/server.mjs:430)-[442](../railway/server.mjs:442)  
**Evidência:** a resposta informa explicitamente `providerProbe: 'not_performed'`; o healthcheck valida configuração/estado local, não a conta Resend ou DNS.  
**Risco:** o Railway pode considerar o serviço saudável enquanto confirmação de cadastro e recuperação de senha estão indisponíveis.  
**Cenário:** domínio remetente perde validação ou a chave é revogada; `/health/ready` permanece verde até uma pessoa tentar receber e-mail.  
**Correção:** adicionar monitor externo de fluxo sintético com caixa controlada (não no healthcheck de alta frequência), alerta para erro de envio e dashboard de entregabilidade.  
**Teste de comprovação:** em staging, invalidar temporariamente uma credencial de teste ou usar mock de erro, confirmar alerta e recuperação sem expor destinatários/tokens.

### P2-03 — Backup integral não é atômico, não possui integridade de arquivo final e contém dados pessoais em download manual

**Arquivo/linha:** [railway/full-backup.mjs:25](../railway/full-backup.mjs:25)-[41](../railway/full-backup.mjs:41), [railway/full-backup.mjs:94](../railway/full-backup.mjs:120), [railway/server.mjs:476](../railway/server.mjs:476)-[500](../railway/server.mjs:500)  
**Evidência:** as tabelas são lidas uma a uma fora de snapshot transacional; depois as mídias são lidas. O download contém usuários, progresso e pagamentos e não tem checksum/assinatura do arquivo completo, criptografia ou agendamento.  
**Risco:** backup inconsistente em alterações concorrentes, arquivo confidencial perdido no computador do proprietário e restauração difícil de validar.  
**Cenário:** uma matrícula é criada entre a leitura de `app_users` e `app_enrollments`, ou mídia é substituída durante o stream; o arquivo parece concluído mas não representa um ponto consistente.  
**Correção:** para produção, usar snapshots nativos do PostgreSQL e versionamento/backup do bucket; se mantiver export lógico, congelar ou usar snapshot transacional, registrar manifest com hash total, criptografar em repouso, definir retenção e restringir o armazenamento do arquivo.  
**Teste de comprovação:** executar backup sob carga controlada, verificar checksum, restaurar em ambiente isolado e comparar integridade/contagens.

### P2-04 — Exclusão forçada de mídia deixa referências quebradas no curso

**Arquivo/linha:** [worker.mjs:1367](../worker.mjs:1367)-[1383](../worker.mjs:1383)  
**Evidência:** com `?force=true`, o objeto e a linha de mídia são removidos, mas as referências nos JSONs de curso não são atualizadas; a resposta apenas lista `referencesRemoved`.  
**Risco:** curso publicado pode manter PDF/vídeo/capa inexistente e falhar para alunos, sem recuperação automática.  
**Cenário:** administrador confirma exclusão forçada de um vídeo usado; o catálogo permanece publicado, mas player retorna 404.  
**Correção:** por padrão, bloquear exclusão referenciada; para força, obrigar seleção de substituto/remover referências em transação lógica, arquivar cursos afetados ou executar reparo auditado antes da exclusão.  
**Teste de comprovação:** excluir mídia vinculada em staging, confirmar que não é possível publicar conteúdo quebrado e que a substituição mantém acesso de alunos.

### P2-05 — CSP mantém `unsafe-inline`, reduzindo a proteção contra XSS futura

**Arquivo/linha:** [railway/server.mjs:48](../railway/server.mjs:48)-[61](../railway/server.mjs:61)  
**Evidência:** `script-src` e `style-src` permitem `unsafe-inline`; o frontend depende de atributos `onclick` e templates HTML.  
**Risco:** se qualquer interpolação escapar de forma incompleta, a CSP não impedirá execução de JavaScript injetado.  
**Cenário:** uma futura tela adiciona campo administrativo a um template sem `escapeHtml`; o conteúdo persistido executa em sessão administrativa.  
**Correção:** substituir handlers inline por listeners, adotar nonce/hash para scripts/estilos necessários e manter teste de XSS de campos de curso, mídia e aluno.  
**Teste de comprovação:** CSP sem `unsafe-inline` em staging e casos de payload HTML/JS persistido renderizados como texto.

### P2-06 — A documentação principal contradiz a regra atual de conteúdo opcional

**Arquivo/linha:** [README.md:50](../README.md:50)-[56](../README.md:56), [GUIA-ADMINISTRACAO.md:18](../GUIA-ADMINISTRACAO.md:18)-[20](../GUIA-ADMINISTRACAO.md:20)  
**Evidência:** o README diz que toda lição precisa de PDF, vídeo e exatamente cinco questões; o guia e o backend aceitam PDF, vídeo e teste como opcionais.  
**Risco:** equipe de conteúdo recebe instrução errada, recria bloqueios removidos ou deixa de publicar cursos válidos apenas de vídeo.  
**Cenário:** um responsável segue o README, acredita que curso de vídeo não é permitido e adia indevidamente lançamento.  
**Correção:** atualizar README e qualquer material de treinamento para a mesma matriz de validação do backend; manter teste de documentação/UX para conteúdos opcionais.  
**Teste de comprovação:** criar e publicar em staging lições somente vídeo, somente PDF, somente atividade e combinadas, seguindo o guia atualizado.

### P2-07 — O caminho alternativo de `worker.mjs` depende de cabeçalhos de identidade e é inseguro se for exposto sem o servidor Node

**Arquivo/linha:** [worker.mjs:261](../worker.mjs:261)-[289](../worker.mjs:289), [railway/server.mjs:129](../railway/server.mjs:166)  
**Evidência:** o worker confia nos cabeçalhos `oai-authenticated-user-*`; o servidor Node os remove da solicitação externa e só depois injeta identidade vinda da sessão, o que é correto no caminho Railway. Se o worker for publicado diretamente, o cliente pode forjar esses cabeçalhos.  
**Risco:** uma futura implantação como Worker/rota direta pode expor administração e mídia sem autenticação de sessão.  
**Cenário:** alguém aponta uma rota de edge diretamente para `worker.mjs` reutilizando a API, sem o proxy `server.mjs`; uma requisição com cabeçalho forjado passa por `readIdentity`.  
**Correção:** remover/desativar o entrypoint legado da entrega de produção ou fazer o worker validar sessões por conta própria; documentar que ele nunca deve receber tráfego público direto.  
**Teste de comprovação:** teste de implantação que tente chamar o worker direto com cabeçalhos forjados e confirme `401/403`.

### P3-01 — Mensagem final do aluno permanece fixa para “Módulo 1 da Jornada Lidere”

**Arquivo/linha:** [app.js:3231](../app.js:3231)-[3239](../app.js:3239)  
**Evidência:** o texto de conclusão é fixo e não usa título do curso ou módulo atual.  
**Risco:** comunicação incorreta para qualquer curso que não seja Jornada Lidere.  
**Cenário:** aluno conclui um curso de família ou discipulado e recebe parabéns por “Jornada Lidere”.  
**Correção:** derivar nome do curso/módulo do objeto atual e escapar a saída.  
**Teste de comprovação:** concluir a última lição de dois cursos com nomes distintos e validar a mensagem.

### P3-02 — HSTS não é enviado pelo servidor

**Arquivo/linha:** [railway/server.mjs:102](../railway/server.mjs:115)  
**Evidência:** os cabeçalhos de segurança incluem CSP, COOP, Permissions-Policy, Referrer-Policy, nosniff e X-Frame-Options, mas não `Strict-Transport-Security`.  
**Risco:** menor proteção contra downgrade para HTTP no primeiro acesso a domínio já exclusivamente HTTPS.  
**Correção:** após confirmar domínio final/HTTPS e subdomínios, configurar HSTS no proxy ou aplicação com período inicial curto e evolução controlada.  
**Teste de comprovação:** checar cabeçalho no domínio de staging e produção, sem quebrar ambientes locais.

## Divergências em relação ao relatório de homologação

| Documento | Declaração | Evidência do código | Resultado |
| --- | --- | --- | --- |
| Relatório de homologação, linha 44 | “pré-requisitos, fases e acessos excepcionais” cobertos | `accessPolicy` só contém modo, pré-requisitos e visibilidade; não há tabela/rota/teste de fase por aluno ou exceção | **Divergência material — P1-04** |
| Relatório de homologação, linha 53 | LGPD e cookies tratados | páginas existem, mas `index.html` ainda informa “Minuta em revisão jurídica” | **Parcial — P0-02** |
| Relatório de homologação, linhas 116–123 | rastreabilidade e restore são gates | pacote continua sem `.git`; não há restore automático | **Pendente — P0-01/P1-03** |
| README, linhas 50–56 | PDF, vídeo e cinco questões obrigatórios | guia e validação atual permitem recursos opcionais | **Divergência operacional — P2-06** |
| Relatório, linhas 35–54 | 155 testes aprovados | comando local confirmou 155 aprovações; cobertura de serviços reais não foi demonstrada | **Confirmado parcialmente** |

## Pontos fortes confirmados no código

- Senhas usam `scrypt` com salt aleatório e comparação constante; tokens de sessão/e-mail são opacos e persistidos como HMAC/hash, não em texto puro ([railway/auth-crypto.mjs:40](../railway/auth-crypto.mjs:40)-[112](../railway/auth-crypto.mjs:112)).
- Cookies de sessão incluem `HttpOnly`, `SameSite=Lax` e `Secure` em hospedagem ([railway/application-api.mjs:711](../railway/application-api.mjs:711)-[733](../railway/application-api.mjs:733)).
- Mutação em ambiente hospedado exige origem e há validação de origem no backend ([railway/server.mjs:456](../railway/server.mjs:456)-[470](../railway/server.mjs:470); [railway/application-api.mjs:667](../railway/application-api.mjs:667)-[674](../railway/application-api.mjs:674)).
- API de pagamento deriva preço do curso no servidor, usa chave de idempotência e consulta a order no provedor antes de liberar matrícula ([railway/application-api.mjs:2552](../railway/application-api.mjs:2552)-[2563](../railway/application-api.mjs:2563), [2802](../railway/application-api.mjs:2802)-[2875](../railway/application-api.mjs:2875)).
- Webhook exige assinatura HMAC e não confia apenas no payload ([railway/application-api.mjs:2782](../railway/application-api.mjs:2782)-[2799](../railway/application-api.mjs:2799), [3123](../railway/application-api.mjs:3123)-[3147](../railway/application-api.mjs:3147)).
- Rotas de mídia protegida verificam sessão, matrícula ativa, publicação e pré-requisitos antes de liberar PDF/vídeo ([railway/server.mjs:260](../railway/server.mjs:260)-[301](../railway/server.mjs:301)).
- Migrations PostgreSQL usam lock transacional e checksums ([railway/migrate.mjs:39](../railway/migrate.mjs:39)-[87](../railway/migrate.mjs:87)).
- Arquivos públicos são servidos por allowlist e verificação de traversal ([railway/server.mjs:366](../railway/server.mjs:366)-[412](../railway/server.mjs:412)).

## Plano priorizado de correção

1. **P0:** criar repositório/tag/CI e aprovar juridicamente políticas finais.
2. **P1:** corrigir revogação de matrícula em refund/chargeback e o bypass de conclusão de vídeo; acrescentar testes de regressão.
3. **P1:** construir e ensaiar migração SQLite → PostgreSQL/S3 e restore completo; não migrar dados reais sem dry-run e conferência de hashes.
4. **P1:** decidir formalmente se fases/exceções entram no lançamento. Se não entram, corrigir todas as alegações e fluxos pastorais; se entram, implementar no servidor e em auditoria.
5. **P1:** tornar a imagem Docker reproduzível com lockfile e CI.
6. **P2:** implementar rate limit compartilhado/WAF, alertas de e-mail, política operacional de backups e remoção segura de mídia.
7. **P2/P3:** endurecer CSP, remover caminho legado inseguro, corrigir documentos e textos fixos, considerar HSTS.

## Checklist de homologação final

- [ ] Commit/tag/release e imagem Docker correspondem ao código revisado.
- [ ] `pnpm install --frozen-lockfile`, `npm test` e `pnpm audit --prod` executados em CI; alertas altos/críticos tratados.
- [ ] Contas reais de aluno, facilitador, administrador e proprietário testadas; nenhuma rota administrativa aceita papel indevido.
- [ ] Cadastro, confirmação, reenvio, recuperação, troca de senha, logout e expiração testados em caixas externas reais.
- [ ] Teste de CSRF/origem, IDOR (outro aluno/checkout/progresso), XSS persistido, upload inválido e download de mídia protegida executados.
- [ ] Curso somente vídeo, somente PDF, somente atividade e combinado publicados e concluídos conforme regras aprovadas.
- [ ] Teste de vídeo direto não conclui lição; player legítimo conclui apenas após condição aprovada.
- [ ] Compra de teste documentada: checkout, webhook válido, consulta da order, matrícula; cenários pendente, erro, duplicidade, estorno e chargeback incluídos.
- [ ] Navegação responsiva e acessível testada em Chrome, Firefox, Safari/iOS e Android; teclado, foco, contraste e leitor de tela básico.
- [ ] Logs, métricas, alertas, backup, restore e rollback ensaiados em staging.

## Checklist de migração para PostgreSQL e armazenamento definitivo

- [ ] Provisionar PostgreSQL privado, usuário com menor privilégio, TLS/URL interna, backups nativos e retenção aprovada.
- [ ] Provisionar bucket privado compatível com S3, credenciais mínimas, endpoint HTTPS, versionamento/cópia e inventário.
- [ ] Construir ferramenta de export/dry-run/import validada, incluindo cursos, usuários, sessões excluídas por decisão, matrículas, progresso, quizzes, checkouts, completions e mídias por chave/hash.
- [ ] Colocar escrita administrativa em manutenção durante o corte ou executar delta final controlado.
- [ ] Aplicar migrations no PostgreSQL vazio; importar para staging; conferir contagens, hashes, amostra de mídias e acessos por usuário.
- [ ] Ensaiar rollback para a origem antes de mudar `DATABASE_URL`/storage em produção.
- [ ] Apontar produção somente após backup da origem, evidência de restore e aprovação técnica registrada.

## Checklist para ativar Mercado Pago em produção

- [ ] Rotacionar todas as credenciais compartilhadas durante desenvolvimento; guardar somente em variáveis protegidas, nunca no repositório.
- [ ] Criar ambiente **production** separado de staging, com `CHECKOUT_MODE=production`, token de produção e segredo de webhook de produção corretos.
- [ ] Configurar URL de webhook de produção no painel do provedor e validar assinatura, tipo `order` e consulta server-to-server.
- [ ] Configurar URLs de retorno usando domínio final HTTPS.
- [ ] Corrigir e testar revogação/reconciliação para refund, cancelamento e chargeback antes de cobrar pessoas reais.
- [ ] Definir responsável financeiro, conciliação diária, política de reembolso, suporte e procedimento de incidente.
- [ ] Executar compra real controlada de baixo valor somente após autorização financeira, com conciliação e comprovantes; não usar conta de teste em produção.

## Riscos que exigem aceite formal se não forem corrigidos

- Operar com SQLite/volume único: indisponibilidade, ausência de alta disponibilidade e recuperação dependente de processo manual.
- Abrir matrícula paga sem revogação em estorno/chargeback: perda financeira deliberadamente aceita.
- Usar conclusão de vídeo como requisito/certificação sem corrigir a sincronização: progresso acadêmico não confiável.
- Declarar fases/liberações excepcionais sem implementá-las: risco pastoral e de comunicação.
- Manter documentos jurídicos como minuta: risco regulatório/LGPD.
- Manter backup sem restore ensaiado: risco de perda permanente de dados e mídias.

## Avaliação dos 155 testes

Os 155 testes são uma boa rede de regressão local e cobrem sintaxe, autenticação, sessão, idade mínima, e-mail, papéis, catálogo, recursos opcionais, mídia, progresso, quiz, webhook, idempotência e migrations em nível unitário/integrado. Eles **não são suficientes para liberar produção sozinhos**.

Faltam, no mínimo: PostgreSQL real, S3/bucket real e IAM, restauração, migração de dados existentes, e-mail entregue de fato, domínio/DNS/HTTPS, acessibilidade e celulares reais, dependências auditadas, estorno/chargeback, bypass de vídeo, testes distribuídos de rate limit e monitoramento/alertas. O teste de migration PostgreSQL atual é um mock de conexão e o de backup não restaura o arquivo; portanto, eles não comprovam essas garantias operacionais.

## Orientações de manutenção

1. Manter uma única fonte de verdade: repositório privado, pull requests, CI e release tags.
2. Nunca compartilhar segredos por chat ou arquivo; usar variáveis protegidas por ambiente e rotação documentada.
3. Separar desenvolvimento, staging e produção; nunca testar pagamentos, dados ou migrations diretamente em produção.
4. Registrar toda alteração de curso publicado, função, matrícula manual, fase/exceção futura e operação financeira em auditoria.
5. Fazer backup verificável e teste de restore periódico; revisar retenção e acessos ao arquivo.
6. Atualizar documentação quando uma regra mudar — especialmente conteúdo opcional, categorias, acesso e pagamentos.
7. Manter um runbook simples para incidentes: serviço fora, e-mail falhando, pagamento pendente, mídia indisponível, rollback e pedido LGPD.

## Conclusão

O Beta Cursos está em estágio avançado de homologação, mas não deve ser anunciado como versão final pronta para operação pública até que os P0 e P1 estejam fechados e comprovados no ambiente definitivo. Nenhuma afirmação sobre o deploy Railway, as variáveis atuais, o banco publicado, bucket, entrega do Resend, domínio ou pagamento de produção é feita neste relatório: todos esses pontos permanecem **NÃO VERIFICADOS** nesta auditoria somente leitura.

