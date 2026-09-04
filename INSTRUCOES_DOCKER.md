# Executar o ROKIT Automatic Path Planner com Docker

O contentor inclui a interface web React, o proxy do ROKIT Locator e a ponte
MQTT. Toda a aplicação fica disponível numa única porta: **8787**.

## Requisitos

- Windows 10/11 com [Docker Desktop](https://www.docker.com/products/docker-desktop/) iniciado; ou Docker Engine com o plugin Compose em Linux.
- Acesso de rede do computador ao ROKIT Locator e ao broker MQTT.

## Arranque rápido no Windows

1. Extraia o ZIP para uma pasta normal (não execute diretamente dentro do ZIP).
2. Opcionalmente, copie `.env.example` para `.env` e altere os dados do Locator.
3. Faça duplo clique em `executar-docker.bat`.
4. Abra `http://localhost:8787` caso o navegador não abra automaticamente.

O primeiro arranque descarrega as imagens base e compila o projeto, por isso
pode demorar alguns minutos.

## Arranque pela linha de comandos

Na pasta do projeto:

```powershell
Copy-Item .env.example .env
# Edite o .env se necessário, sem partilhar palavras-passe.
docker compose up --build -d
```

Abrir: <http://localhost:8787>

Ver estado e registos:

```powershell
docker compose ps
docker compose logs -f
```

Parar a aplicação:

```powershell
docker compose down
```

Recompilar depois de alterar o código:

```powershell
docker compose up --build -d
```

## Execução sem Docker (desenvolvimento)

É necessário Node.js 22. Na pasta do projeto:

```powershell
npm ci
npm run dev
```

Depois abra <http://localhost:5173>. O servidor auxiliar é iniciado na porta
8787.

## Configuração e rede

- As opções principais do Locator estão em `.env.example`. O ficheiro `.env`
  real não está incluído no ZIP para não expor credenciais.
- Por omissão, o Locator é `192.168.1.104:18082` e a aplicação é publicada em
  `localhost:8787`.
- Configure o broker MQTT na página **Settings** da aplicação.
- Se o Locator ou MQTT estiver noutra máquina, confirme que o Docker Desktop
  tem acesso à mesma rede/VPN e que as firewalls permitem as respetivas portas.
- Para abrir a interface a partir de outro computador, use
  `http://IP_DO_COMPUTADOR:8787` e permita a porta 8787 na firewall. Algumas
  integrações locais foram concebidas para uso no próprio computador anfitrião.

## Verificação rápida

Com o contentor iniciado, este endereço deve responder com `"ok": true`:

<http://localhost:8787/health>
