# Med Robots Mission Planner

Aplicação web e desktop para planear e acompanhar missões de robôs Bosch ROKIT
Navigator. Integra mapas do ROKIT Locator, telemetria e ordens VDA 5050 através
de MQTT, com validação de rotas e ferramentas de diagnóstico.

> **Aviso de segurança:** esta aplicação não é uma função de segurança certificada
> e não envia comandos diretos a motores ou PLCs. A segurança do veículo depende
> do hardware certificado e do sistema de segurança da instalação.

## Requisitos

- Node.js 22 e npm para desenvolvimento.
- Docker Desktop com Compose para execução em contentor.
- Acesso de rede ao ROKIT Locator e ao broker MQTT da instalação.

## Desenvolvimento

No PowerShell, a partir da pasta do projeto:

```powershell
npm ci
npm run dev
```

Abra <http://localhost:5173>. A interface web usa o servidor local de integração
na porta `8787`.

Para configurar o ROKIT Locator, copie `.env.example` para `.env` e ajuste os
valores ao ambiente local. Configure o broker MQTT e os tópicos na página
**Settings**. Não partilhe nem versione credenciais reais.

## Docker

```powershell
Copy-Item .env.example .env
# Edite .env e substitua os valores de exemplo antes de ligar à instalação.
docker compose up --build -d
```

A aplicação fica disponível em <http://localhost:8787>; o estado do serviço pode
ser verificado em <http://localhost:8787/health>. Para detalhes de configuração
e resolução de problemas, consulte [Instruções Docker](docs/INSTRUCOES_DOCKER.md).

## Comandos úteis

| Comando | Descrição |
| --- | --- |
| `npm run dev` | Inicia a interface web e o servidor local. |
| `npm run test` | Executa os testes automatizados. |
| `npm run typecheck` | Verifica os tipos TypeScript. |
| `npm run lint` | Analisa o código com ESLint. |
| `npm run build` | Compila a aplicação web, servidor e Electron. |
| `npm run electron:dev` | Inicia a versão desktop em desenvolvimento. |
| `npm run electron:build` | Gera a aplicação desktop instalável. |

## Estrutura

- `src/domain` — geometria, planeamento, validação e modelos VDA 5050.
- `src/features`, `src/components` e `src/stores` — interface, fluxos e estado.
- `src/workers` — execução do planeador fora da thread da interface.
- `server` — ponte MQTT e proxies locais para Locator e Data Layer.
- `electron` — processo principal e API isolada da aplicação desktop.
- `examples` — mapas, mensagens e dados de exemplo para testes.
- `docs` — arquitetura, operação, configuração e relatórios técnicos.

## Documentação

- [Guia global de documentação técnica e operação](docs/OPERATOR_GUIDE.md)
- [Arquitetura e limites do sistema](docs/ARCHITECTURE.md)
- [Configuração Docker](docs/INSTRUCOES_DOCKER.md)
- [Gravação e reprodução de cenários Stage 5B](docs/STAGE_5B_RECORDER.md)
- [Fluxo de comparação Stage 5B](docs/STAGE_5B.md)
- [Notas sobre os registos de missões de exemplo](docs/MISSION_LOGS.md)
- [Relatórios e evidência histórica](docs/reports/)

## Licença e utilização

Consulte as condições de utilização aplicáveis à sua instalação antes de
distribuir ou ligar a aplicação a um robô real. Teste alterações com dados e
equipamento apropriados, mantendo as funções de segurança independentes.
