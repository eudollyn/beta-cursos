# Restauração e migração do Beta Cursos

Este procedimento transfere o backup integral do Beta Cursos para outro banco e outro armazenamento. Ele serve tanto para recuperação quanto para a passagem de SQLite/filesystem para PostgreSQL/S3.

## Garantias da ferramenta

- O comando é **dry-run por padrão**: valida o arquivo, tabelas, contagens, hashes e o destino sem gravar nada.
- Um destino que já contém dados é recusado por padrão.
- Arquivos existentes só são reutilizados quando tamanho e SHA-256 conferem; arquivos diferentes nunca são sobrescritos.
- Os dados entram em uma única transação. Se a transação falhar, os arquivos criados naquela tentativa são removidos.
- Sessões e tokens temporários não são restaurados. Todos os usuários precisam entrar novamente, o que é intencional.
- A versão de schema do destino não é rebaixada pela versão registrada no backup.

## Antes de começar

1. Coloque a aplicação de origem em manutenção ou interrompa escritas durante a geração do backup.
2. Baixe o backup integral pela conta de proprietário e guarde-o em local criptografado e restrito.
3. Crie um banco e um bucket **vazios** para o destino.
4. Configure no terminal as variáveis do destino (`DATABASE_URL`, `STORAGE_DRIVER` e variáveis S3) sem colocá-las em arquivos versionados.
5. Execute as migrations no destino:

   ```bash
   pnpm migrate
   ```

## Simulação obrigatória

```bash
pnpm restore --file caminho/beta-cursos-backup-completo-AAAA-MM-DD.ndjson.gz
```

O relatório deve mostrar `"dryRun": true`, as contagens esperadas e zero dados relevantes no destino. Nenhuma gravação é feita.

## Aplicação

Depois de revisar o relatório do dry-run:

```bash
pnpm restore --file caminho/beta-cursos-backup-completo-AAAA-MM-DD.ndjson.gz --apply
```

`--allow-nonempty` existe para uma recuperação excepcional, mas não transforma o processo em um merge automático. Conflitos continuam interrompendo a transação. Não use essa opção em produção sem uma revisão técnica específica.

## Validação pós-migração

Compare as contagens do relatório e valide, em staging:

- login de uma conta existente;
- listagem e abertura de cursos publicados;
- matrículas gratuitas e pagas;
- progresso, avaliações e conclusões;
- reprodução/abertura de cada tipo de mídia;
- painel de alunos, papéis administrativos e trilha de auditoria;
- backup novo do destino e dry-run desse novo backup em um terceiro destino vazio.

O primeiro ensaio PostgreSQL/S3 real deve ocorrer em staging. A aprovação exige que os hashes dos arquivos e as contagens de todas as tabelas coincidam.

## Rollback

Antes da virada, mantenha a origem intacta e somente leitura. Se a validação falhar:

1. não aponte o domínio para o destino;
2. descarte apenas o banco/bucket novos usados no ensaio;
3. corrija a causa;
4. gere um backup novo da origem e repita o dry-run.

Nunca apague a origem antes de uma janela de retenção aprovada e de um restore completo comprovado.

## Limites que ainda dependem da infraestrutura final

A ferramenta e seus testes locais estão prontos, mas a comprovação final requer PostgreSQL e S3 reais fornecidos/configurados na infraestrutura da igreja. Backups automáticos, retenção, criptografia gerenciada e recuperação de desastre devem ser definidos com o responsável pela hospedagem.
