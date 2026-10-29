# Bolão da Família

Aplicação Node.js sem dependências externas. O servidor entrega o `index.html`, recebe as operações pela API e salva palpites, prêmio, prazo, encerramento e resultado oficial em `data/bolao.json`. O arquivo é criado automaticamente na primeira inicialização. Não abra mais o HTML diretamente: use o servidor.

## Executar localmente

Requer Node.js 22.17 ou superior.

```powershell
Copy-Item .env.example .env
# Edite .env e escolha uma ADMIN_PASSWORD própria, com pelo menos 12 caracteres.
npm start
```

Abra http://localhost:3000. Não é necessário executar `npm install`. Para verificar as regras e a persistência: `npm test`.

## Deploy na Coolify (Docker Compose recomendado)

1. Envie esta pasta para um repositório Git, sem `.env` e sem a pasta `data`.
2. Na Coolify, crie uma aplicação a partir desse repositório, escolhendo Docker Compose e o arquivo `/docker-compose.yml`.
3. Nas variáveis de ambiente da aplicação, configure `ADMIN_PASSWORD` com uma senha longa e exclusiva (mínimo de 12 caracteres). Não use o valor do exemplo. A senha nunca é enviada ao frontend ou gravada no JSON.
4. Configure o domínio do serviço `bolao` usando a porta interna `3000`, por exemplo `https://bolao.seudominio.com:3000`. Ative HTTPS: o cookie de administração usa `Secure` em produção.
5. Faça o deploy. Confira o serviço saudável pelo health check `/health` e verifique em Persistent Storages o volume `bolao_data` montado em `/app/data`.
6. Acesse o domínio, entre na aba Administração com a senha configurada e defina prêmio e prazo.

O Compose já declara o volume persistente. Ele conserva o JSON quando o container é substituído. Não remova o volume, não execute `docker compose down -v` e não altere seu nome ao atualizar o projeto. Preserve o mesmo recurso da Coolify para reutilizar o armazenamento.

Alternativa: use o build pack Dockerfile, porta `3000`, variável `ADMIN_PASSWORD` e adicione manualmente um volume persistente com destino `/app/data`. O Dockerfile sozinho não configura o armazenamento na Coolify.

Referências: [Docker Compose na Coolify](https://coolify.io/docs/services/configuration/docker-compose) e [armazenamento persistente](https://coolify.io/docs/applications/configuration/persistent-storage).

## Lógica e funcionamento

- Um palpite por nome, ignorando espaços nas extremidades, maiúsculas e acentos. Essa é uma identificação por nome; participantes não possuem contas ou verificação de identidade.
- Placar entre 0 e 15 gols por time, coerente com o vencedor selecionado.
- Pontuação cumulativa: 10 pelo placar exato, 5 pelo resultado e 3 pelo autor de gol. Nomes de jogadores são comparados ignorando acentos e maiúsculas.
- Desempate: placar exato e, depois, envio mais antigo. Se dois envios tiverem o mesmo milissegundo, prevalece a ordem de registro.
- O servidor verifica duplicidade e encerramento, mesmo se o navegador for manipulado. Publicar o resultado encerra os palpites. Para abrir novamente depois de publicar, reinicie o bolão.
- O prazo é informado no horário local do navegador do organizador e armazenado em UTC. Cada participante vê a data convertida para seu horário local.
- O ranking e as configurações são compartilhados; a tela consulta atualizações a cada 15 segundos.
- Administração autenticada por cookie HttpOnly com validade de 8 horas. Reiniciar o servidor exige novo login. Reiniciar o bolão apaga os dados do jogo, preservando a senha definida no ambiente.
- Gravações são serializadas em um único processo, sincronizadas em disco e publicadas por substituição do arquivo. Um JSON inválido impede a inicialização para evitar apagar os dados existentes.

## Armazenamento e backup

Em produção, o arquivo fica em `/app/data/bolao.json`. Localmente fica em `data/bolao.json`. A variável `DATA_DIR` permite escolher outra pasta; o destino do volume deve acompanhar essa mudança.

Use **Exportar palpites (JSON)** no painel do organizador para baixar todos os dados do jogo. Faça backups regulares fora do servidor; o volume persistente não substitui backup.

Para restaurar um backup: pare a aplicação, copie um JSON exportado para `bolao.json` no volume e inicie novamente. Preserve a permissão de escrita para o usuário `node` do container (UID 1000). O JSON não contém a senha de administração.

Os dados da versão antiga permanecem apenas no `localStorage` de cada navegador e não são migrados automaticamente. Se houver dados reais antigos, exporte-os antes de trocar a versão. Para restaurá-los, mantenha somente os campos `palpites`, `premio`, `prazo`, `fechado` e `resultado`; remova `hash`, converta o prazo local para ISO UTC e confira o resultado antes de substituir o arquivo no servidor.

Execute **uma única instância** do servidor usando esse arquivo. Não use múltiplas réplicas, cluster Node.js ou dois processos escrevendo no mesmo volume. Essa persistência é adequada ao bolão familiar; maior escala exige banco de dados.
