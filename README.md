# Rede — monitoramento de rede

Painel web com três abas (e modo **lado a lado**):

- **Monitor** — varre as faixas de IP (ping + portas TCP + SNMP/HTTP/NetBIOS), classifica os equipamentos e avisa quando um conhecido cai. Usa toda a largura da janela, no mesmo padrão visual da Topologia: painel lateral (status, busca, tipos de equipamento, ordenação/agrupamento/visualização e alertas) e, ao lado, a barra de comando, o resumo e os equipamentos. Endereços varridos que ainda não responderam só aparecem como cartão quando ficam online (os conhecidos e cadastrados sempre aparecem).
- **Topologia** — três visões: árvore de equipamentos, **infraestrutura** (cartões com CPU/memória, portas de uplink/downlink) e **racks** (um gabinete por concentrador, com os switches abaixo dele); com filtros, busca, "seleção em destaque" e linha do tempo.
- **Tráfego** — portas dos MikroTik (RouterOS) via SSH: painel de portas, insights, ambiente (waveform/waterfall) e vizinhos descobertos. Em **Todos os equipamentos** a ordem é fixa: **cartões de totais** em cima; **utilização dos links**: uma **barra geral de uma cor por hack** (.4, .5, .6, .7…), cujo tamanho de cada cor é proporcional ao tráfego que chega por ele (ao vivo, com nome e percentual na própria barra), e logo abaixo a barra de **uso total do equipamento da Internet** (o de tipo de rack "Internet", 10.20.12.1), que recebe tudo; depois **um bloco por hack** (2 por linha, cada um com cor própria, a sua utilização de links, painel de portas e tabela; filtros e busca valem para todos) e, por último, a saúde da rede e os tops. Cada bloco mostra, o painel de portas e a tabela de **cada** equipamento aparecem ao mesmo tempo (filtros e busca valem para todos).

## Rodar

```bash
npm install
copy config.example.json config.json   # edite com seus equipamentos
node server.js
```

Abra `http://localhost:3030`.

## Portas e cabos (Topologia)

Clique em um equipamento no mapa e abra a aba **Portas**:

- **Configurar** — informe quantas portas RJ45 e SFP ele tem (e um nome, se quiser). Com acesso SSH as portas são detectadas sozinhas.
- **Clique em uma porta → Ligar cabo** — escolha o equipamento do outro lado, a porta dele e se esta porta liga a um equipamento *abaixo* ou *acima*. O mapa passa a mostrar os selos de porta e os rótulos dos links; a aba Tráfego mostra o cabo na coluna "Conexão".
- Quando há SSH, cada porta mostra velocidade, tráfego ao vivo e o vizinho LLDP/MNDP detectado (dá para ligar o cabo com um clique).

- **Tipo de cabo** — cada ligação é *cabo de rede (UTP)* ou *fibra óptica*. Em "Automático" vira fibra quando alguma ponta é porta SFP; dá para forçar no campo "Tipo de cabo". No mapa: UTP em azul, fibra em laranja (com brilho), selo UTP/Fibra no rótulo do link e portas de fibra com contorno laranja.
- **Switches abaixo** — na aba Portas de qualquer equipamento, "Adicionar switch" cadastra um switch (nome, portas RJ45/SFP, porta do concentrador, porta de uplink e tipo de cabo). Dá para cadastrar switches abaixo de switches. Eles não têm IP/SSH: são só inventário e cabeamento.
- **Visão Racks** — **uma aba por rack**, mais a aba **Macro**, que mostra todos os racks como cartões ligados entre si: arraste a alça de um cartão até outro para ligar os racks (escolhendo portas e tipo de cabo), clique duplo numa ligação para removê-la e clique num cartão para abrir o rack. Cada rack tem um **tipo** (Internet, Principal ou Secundário; `rtype` no `inventory`) e o MikroTik dele tem um **papel**: por padrão é *Concentrador* no rack principal e *Core* nos secundários, mas dá para trocar (Internet, Núcleo, Concentrador, Core, Distribuição ou Secundário; `role`). Os switches e demais equipamentos de rack também aceitam um papel. Troque o tipo direto no cabeçalho do rack, em Portas → Configurar ou no modal de clique duplo. O título do rack é montado assim: **Hack <número> - <setor> · Principal/Secundário** (campo **Nº** no cabeçalho; sem número, usa o nome do equipamento). Cada rack também tem **Andar** e **Setor** (`andar` e `setor` no `inventory`): preencha direto no cabeçalho do rack (salva ao sair do campo), em Portas → Configurar ou ao criar; aparecem no cartão do Macro. **Adicionar rack** cria um novo concentrador MikroTik (nome, IP, portas, papel e a que rack ele se liga); a lixeira do rack o remove. Os racks são os MikroTik com SSH, os criados à mão e os que têm portas definidas. um rack 19" por concentrador MikroTik (sempre um só por rack, fixo no topo). O rack do topo da rede é o **Core**; os que ficam abaixo são **Distribuição**. Todo equipamento (switch, patch panel, roteador, servidor, nobreak, organizador, frente falsa (painel cego)...) fica dentro de um rack, nunca solto. Os jacks desenhados são exatamente a quantidade configurada (RJ45 e SFP), com LED, e os **cabos aparecem na frente**, de porta a porta (azul = UTP, laranja = fibra; cabos para outro rack saem pela lateral). Se uma ponta do cabo não tem porta definida (ou a porta não existe no equipamento), o cabo termina num anel tracejado na orelha do equipamento e a dica do cabo diz o que falta. Os cabos saem do centro exato da porta de origem e chegam ao centro exato da porta de destino. **Ligar cabo arrastando**: na frente, arraste de uma porta até outra (a porta de destino fica verde) para criar a ligação; quem já está acima na árvore vira o pai, e se a ligação substituir outra o sistema pergunta antes. Clique duplo num cabo remove. Cada porta (inclusive as do servidor) é um quadrado individual. O botão **Frente / Fundo** alterna entre a frente (portas e cabos) e o fundo do rack (energia, ventilação, console, tomadas do nobreak, blocos do patch panel). **Arraste** um equipamento para mudar a posição ou para outro rack. Use **Adicionar equipamento** (ou o "+" do rack) para cadastrar; em Portas → Configurar dá para mudar tipo, altura e rack.

O botão **Desfazer** (ou Ctrl+Z) na barra da Topologia reverte, um a um, as últimas alterações de ligações, portas e equipamentos (até 50, enquanto a página estiver aberta).

Tudo isso é salvo no `config.json` (chaves `links` e `inventory`).

## Segurança contra dados defasados

O servidor só aceita gravar a topologia de uma página que tenha lido a versão atual (`rev`). Uma página aberta há muito tempo (ou antes de um reinício) recebe um aviso para recarregar com F5 em vez de sobrescrever o `config.json` com dados antigos.

## config.json

```json
{
  "port": 3030,
  "intervalMs": 1000,
  "devices": [
    { "name": "Core", "host": "10.20.12.1", "user": "admin", "password": "senha", "port": 22 }
  ],
  "links": [
    ["10.20.12.1", "10.20.12.4", "2", "1"],
    ["10.20.12.4", "10.20.12.5", "6", "S1", "fibra"],
    ["10.20.12.4", "sw-1", "7", "1", ""]
  ],
  "inventory": {
    "10.20.12.4": { "name": "SW-04", "ports": 24, "sfp": 2 },
    "sw-1": { "name": "Switch Sala TI", "ports": 16, "sfp": 0, "sw": true }
  }
}
```

- `devices` — equipamentos RouterOS lidos por SSH (a aba Tráfego também edita esta lista; `port` é opcional).
- `links` — cabos `[pai, filho, porta do pai, porta do filho, tipo]`; porta é `"3"` (RJ45) ou `"S1"` (SFP), e pode ficar vazia; tipo é `"utp"`, `"fibra"` ou vazio (automático). Normalmente editado pela própria Topologia.
- `inventory` — por IP: `name` (opcional), `ports` (RJ45) e `sfp`. Usado quando o equipamento não responde por SSH. Com `"sw": true` é um equipamento de rack cadastrado à mão (a chave é um id como `sw-1`, não um IP); campos extras: `etype` (`switch`, `patch`, `router`, `server`, `ups`, `organizer`, `blank`, `other`), `u` (altura, 1–4) e `rack` (IP do concentrador a que pertence) e `pos` (ordem no rack, definida ao arrastar).
- `known` (opcional) — substitui as listas de equipamentos conhecidos do Monitor: `nucleo`, `accesspoint`, `servers`, `printers`, `defaultRanges`, `scanInterval`.

## O que é lido nos equipamentos (somente leitura)

`/interface monitor-traffic`, `/interface print stats`, `/interface print terse`, `/interface ethernet monitor`, `/ip neighbor print terse`, `/system resource print`.
Velocidade negociada, vizinhos e informações do sistema são atualizados a cada 30 s; o tráfego, a cada `intervalMs`.

## Online/offline em tempo real e tráfego nas linhas

- O servidor faz **ping contínuo (a cada 2 s)** de todo equipamento da topologia: concentradores (pelo IP), switches/equipamentos de rack que tiverem **IP** (campo "IP do equipamento" em Portas → Configurar, ou ao cadastrar) e os equipamentos SSH. O estado (online/offline, tempo de resposta, "há quanto tempo") aparece no mapa e na gaveta (Resumo → Disponibilidade, com uptime de 1 h/24 h/72 h, uma faixa dos últimos 60 minutos e as últimas mudanças de estado). Uma falha isolada não derruba o estado: são necessárias 2 falhas seguidas.
- O **histórico fica em arquivos na pasta do app**: `ping-events.jsonl` (cada mudança de estado, para sempre) e `ping-history.json` (resumo por minuto, últimas 72 h). Ambos estão no `.gitignore`.
- Nas linhas do mapa: duas linhas animadas paralelas por ligação — a de cima é o **download** (anda do pai para o filho) e a de baixo o **upload** (volta). A **cor** vai do verde ao vermelho conforme a utilização do link (taxa ÷ velocidade negociada), e a espessura e a velocidade da animação crescem com a taxa. Sem tráfego a linha base fica pontilhada; sem dados de SSH, só o tipo do cabo. Os valores ↓/↑ também aparecem no rótulo (azul = download, roxo = upload). Precisa de SSH no concentrador do lado do pai (ou do filho) e da porta definida no cabo.

## Notas técnicas

- O Monitor reconhece resposta de ping pelo `TTL=` (funciona com o Windows em qualquer idioma, inclusive português).
- Rotas conhecidas chamadas com método errado respondem `405` em vez de ficar pendentes.
