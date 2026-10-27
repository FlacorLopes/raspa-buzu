# Raspa Buzu: status (27/10/2026)

Jogo de sátira política sobre os ônibus retidos nas garagens de Salvador no 2º turno (25/10/2026).
Linha editorial: **anti-Semob**. Os argumentos mostram que muitos ônibus nem tinham adesivo, que tirar
um adesivo é trivial e que garagens seguiam lotadas depois do "normalizado" da Semob. Os fatos têm fonte
(painel "Sátira · fatos e fontes" no jogo); as falas do secretário e do prefeito são ficção, sinalizada
como sátira.

## No ar

| Endereço | O que é | Projeto Vercel | Branch |
|---|---|---|---|
| https://raspa-buzu.vercel.app | **Produção**: modo câmera (espátula + joinha) | `raspa-buzu` (esta pasta está linkada a ele) | `main` |
| https://raspa-buzu-deslize.vercel.app | Variante com deslize da mão (descartada, guardada) | `raspa-buzu-deslize` | `feat/camera-swipe` (worktree em `~/raspa-buzu-deslize`) |
| https://raspa-buzu-lab.vercel.app | Projeto de testes antigo, **desatualizado** | `raspa-buzu-lab` | (versão de antes do CDN) |

Publicar produção: `vercel deploy --prod --yes` nesta pasta.
O repositório **não tem remote** (só local). A v1 (HTML único, modo toque) está na tag `v1-artifact` e em `legacy/`.

## Como rodar

```bash
pnpm install
pnpm dev          # Vite; abre /camera/ (a raiz só cai no jogo na Vercel, via rewrite)
pnpm test         # node --test (sim, joinha, trava do joinha, níveis, versão do CDN)
pnpm build        # typecheck + build (baixa motor/modelos do MediaPipe para public/mediapipe)
./scripts/og.sh   # regera public/og.png (prévia do link) com Chrome headless
```

Ajudas de teste na URL:
- `?mouse=1`: o mouse faz o papel do dedo (arrastar raspa). Teclas: **W** ou espaço = joinha, **P** = easter egg do prefeito, **E** = pula para o cartão final. `&speed=N` acelera o relógio.
- `?debug=1`: rodapé com detecções/s, inferência, atraso, tempo de desenho, origem do motor/modelo (CDN ou local), gesto reconhecido e estado da trava do joinha.
- `?rec=0`: sem gravação. `?gr=0`: detector antigo (só pontos da mão) no lugar do Gesture Recognizer.
- Teste no celular pela rede local: `pnpm spike:lan` (HTTPS autoassinado, porta 5174). Na prática a Vercel foi mais confiável; o Android cai para dados móveis quando o Wi-Fi fica sem internet.

## Como o jogo funciona (modo câmera, `camera/index.html` + `src/camera/`)

- **Rodada de 56 s + cartão final de 2,5 s** (vídeo ≤ 60 s para story/status; o gravador para sozinho em 59,5 s). Relógio do jogo vai de 06h00 a 17h00.
- **Raspar**: esfregar a ponta do indicador no adesivo do 13 (2 a 4 raspadas). O acerto usa a posição crua do dedo; só o cursor desenhado é suavizado e projetado à frente.
- **Joinha** (MediaPipe Gesture Recognizer, `Thumb_Up` ≥ 0,55 em 2 detecções seguidas) libera ônibus sem o 13. `ThumbGate`: um ônibus por joinha (tem que baixar o polegar), e o ônibus precisa estar parado há 0,4 s.
- Antes das 12h20 do relógio, ônibus com o 13 não sai ("Regra da Semob"). Depois, o joinha solta adesivado.
- **Ônibus**: 60% sem adesivo, 30% com o 13, 10% com adesivo de time/igreja (`src/sim.ts`). O primeiro sempre tem o 13.
- **Penalidade** (dedo parado no adesivo de acessibilidade ou de time/igreja): o ônibus fica **TRAVADO** 1 s. O placar não diminui.
- **Placar** "NA RUA" (só sobe), "PASSAGEIROS ESPERANDO" e **Baratinômetro** (baratino = desculpa esfarrapada): sobe a cada ônibus sem adesivo liberado; níveis Migué (1–3), Quatchá quatchá (4–6), Baratino master (7+).
- **Easter egg**: 3 ônibus liberados em menos de 5 s de jogo mostram a caricatura do prefeito com "Dá uma segurada aí!" (2,6 s, entra no vídeo).
- **Secretário em Paris**: 14 mensagens antes do mandado e 6 depois (`src/content.ts`), sorteadas sem repetir.
- **Eventos do relógio** com fatos: frota prometida, carona solidária, Semob culpa o adesivo, "frota igual ao 1º turno", 11h05 pedido à Justiça, Procon 944 parados, 12h20 "normalizou", Bruno Reis, TRE multa, mandado de prisão, 15h30 Rui Costa.
- **Fim**: tela com o resumo no texto do usuário ("Nível de baratino…"), vídeo (canvas + áudio do jogo, mp4 quando o navegador suporta) e **imagem do placar sem câmera** (1080×1920), cada um com botão de compartilhar e de baixar.
- **Música**: "Bloquinho Hitmado" (EMBeat) toca uma vez a partir do início da gravação, ganho 0,33. Licença: uso não monetizado com crédito obrigatório. O crédito está no cartão final, na mensagem de compartilhar e em "fatos e fontes".

## Desempenho (aprendizados no Galaxy A17)

- O A17 faz ~6–9 detecções/s (~65–115 ms por inferência). A detecção roda num **Web Worker clássico** (o MediaPipe usa `importScripts`), com GPU e CPU como reserva.
- O desenho fica limitado a **30 fps** para sobrar GPU para o detector. Canvas interno de 576×1024 (coordenadas de jogo 720×1280), frente do ônibus em cache, quadros enviados ao worker como `VideoFrame`.
- O que **não** funcionou no A17: tchauzinho por movimento, deslize da palma, reduzir a imagem de entrada, CPU no lugar de GPU.
- **CDN**: motor WASM do jsDelivr (versão fixada em `src/camera/assets.ts`, conferida por teste) e modelo do Google; as cópias em `public/mediapipe` são reserva. Os arquivos em `/assets/*` têm cache imutável de 1 ano (`vercel.json`).

## Fontes usadas no jogo

- Procon-BA, 944 ônibus em 9 garagens (64 na G5): [Governo da Bahia](https://www.ba.gov.br/comunicacao/noticias/2026-10/384959/fiscalizacao-do-procon-ba-registra-944-onibus-parados-em-garagens-de), [BNews](https://www.bnews.com.br/noticias/politica/salvador-teve-944-onibus-parados-em-garagens-no-dia-do-segundo-turno-diz-procon.html)
- Semob: normalizado às 12h20: [Correio](https://www.correio24horas.com.br/eleicoes/prefeitura-de-salvador-diz-que-frota-de-onibus-foi-normalizada-apos-problemas-em-garagens-por-adesivos-eleitorais-1026)
- Rui Costa filma garagem lotada ~15h30: [bahia.ba](https://bahia.ba/politica/rui-costa-garagem-onibus-salvador-prefeito-sabotagem/)
- Mandado revogado ("perdeu o objeto"): [InfoMoney](https://www.infomoney.com.br/politica/justica-revoga-pedido-de-prisao-de-secretario-municipal-de-salvador/)
- Pintura Integra: fotos enviadas pelo usuário (Plataforma amarelo, frota 3xxxx; OT Trans verde, 2xxxx). Linhas reais em `src/lines.ts`.

## Pendências

1. **Testar no iPhone/Safari** (nunca testado).
2. Conferir no celular: botão "Carregando…" → "Ligar câmera" na primeira visita (abrir em aba anônima), volume da música, música dentro do vídeo, compartilhar só o placar.
3. **Selo "sátira" no balão do prefeito** (um trecho do vídeo pode circular sem o cartão final). Confirmar o direito de uso da caricatura.
4. Ver a prévia do link no WhatsApp.
5. Ajustar dificuldade: faixas do baratinômetro (com 60% de ônibus limpos o Baratino master chega cedo) e gatilho do easter egg.
6. Decidir se tira de "fatos e fontes" a frase da Semob sobre "70% da frota".
7. Subir o repositório para um GitHub privado. Apagar o projeto `raspa-buzu-lab` se não for mais usado.
8. Fora de uso: o modo toque (v1, em `legacy/`) e o branch `feat/ranking` (ranking global com Upstash, descartado). As páginas de teste `/spike/camera.html` e `/spike/swipe.html` continuam publicadas.

## Preferências do usuário

- Escreve em pt-BR. É desenvolvedor e testa no Galaxy A17.
- Quer **plano antes** de mudanças grandes e experimentos em **endereço separado**, sem substituir a versão principal.
- Pede commit e deploy a cada mudança aprovada.
