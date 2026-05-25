# Guia de Submissão - Rinha de Backend 2026

## Estrutura de Branches

### Branch `main` (código-fonte)
```
├── api/
│   ├── src/
│   │   └── index.js
│   ├── preprocessor/
│   │   ├── preprocess.js
│   │   ├── package.json
│   │   └── Dockerfile
│   ├── package.json
│   ├── package-lock.json
│   └── Dockerfile
├── nginx/
│   └── nginx.conf
├── resources/
│   ├── mcc_risk.json
│   ├── normalization.json
│   └── references.json.gz
├── cache/
│   ├── labels.bin
│   └── vectors.bin
├── docker-compose.yaml
├── info.json
└── README.md
```

### Branch `submission` (apenas arquivos necessários para teste)
```
├── docker-compose.yml
├── nginx/
│   └── nginx.conf
├── info.json
└── init.sql (se necessário)
```

## Passos para Preparação da Submissão

### 1. Build e Push das Imagens Docker

Substitua `SEU_USUARIO` pelo seu username do Docker Hub:

```bash
# Login no Docker Hub
docker login

# Build da imagem da API
docker build --platform linux/amd64 -t SEU_USUARIO/rinha-api:latest ./api

# Build da imagem do Preprocessor
docker build --platform linux/amd64 -t SEU_USUARIO/rinha-preprocessor:latest ./api/preprocessor

# Push das imagens
docker push SEU_USUARIO/rinha-api:latest
docker push SEU_USUARIO/rinha-preprocessor:latest
```

### 2. Preparar o Branch `submission`

```bash
# Criar e mudar para a branch submission
git checkout -b submission

# Remover arquivos desnecessários (código-fonte)
rm -rf api/
rm -rf resources/
rm -rf cache/
rm -rf .vscode/
rm -f .env
rm -f .gitignore
rm -f docker-compose.yaml

# Renomear o docker-compose de submissão
mv docker-compose.submission.yaml docker-compose.yml

# Editar docker-compose.yml e substituir SEU_DOCKER_HUB_USERNAME pelo seu username
# Use seu editor de texto preferido

# Adicionar arquivos necessários
git add docker-compose.yml
git add nginx/nginx.conf
git add info.json

# Commit
git commit -m "Preparar branch submission para Rinha de Backend 2026"

# Push para o remoto
git push origin submission
```

### 3. Modificações Feitas nas Dockerfiles

#### API Dockerfile
- Adicionado `COPY resources ./resources` para embutir os arquivos de recursos
- Adicionadas variáveis de ambiente `RESOURCES_DIR` e `CACHE_DIR`

#### Preprocessor Dockerfile
- Adicionado `COPY resources ./resources` para embutir os arquivos de recursos
- Adicionadas variáveis de ambiente `RESOURCES_DIR` e `CACHE_DIR`

### 4. Mudanças no docker-compose.yml

**Removido:**
- Build contexts (substituído por imagens do Docker Hub)
- Volume mounts para `./resources` (agora embutidos nas imagens)

**Mantido:**
- Volume `cache` para compartilhamento entre preprocessor e APIs
- Configurações de rede e recursos

## Importante

1. **Cache Volume**: O volume `cache` é criado pelo Docker e compartilhado entre o preprocessor e as APIs. O preprocessor gera os arquivos binários e as APIs os leem. Isso funciona no ambiente de teste pois é um volume Docker local.

2. **Recursos Embutidos**: Os arquivos `mcc_risk.json`, `normalization.json` e `references.json.gz` agora estão embutidos nas imagens Docker, eliminando a necessidade de volume mounts externos.

3. **Imagens Públicas**: Certifique-se de que suas imagens no Docker Hub são públicas para que os juízes do teste possam puxá-las.

4. **Platform**: As imagens são buildadas com `--platform linux/amd64` para garantir compatibilidade com o ambiente de teste.

## Testando Localmente

Antes de submeter, teste localmente:

```bash
# Usando o docker-compose original (com build local)
docker-compose up --build

# Ou usando o docker-compose de submissão (após push das imagens)
docker-compose -f docker-compose.submission.yaml up
```

## Verificação

Antes do push final, verifique que a branch `submission` contém apenas:
- `docker-compose.yml`
- `nginx/nginx.conf`
- `info.json`

Nenhum código-fonte deve estar presente na branch submission.
