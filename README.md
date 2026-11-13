# photo2game

Turns a photo of a real place into a walkable 3D environment, with a generic character (walk, run, jump), collision physics and a live test viewer. The photo decides the environment type, and the environment type decides which 3D objects are placed around the character.

Este projeto transforma a foto de um lugar real em um ambiente 3D que pode ser percorrido, com um personagem genérico (andar, correr, pular), física de colisão e um visualizador de teste ao vivo. A foto define o tipo de ambiente, e o tipo de ambiente define quais objetos 3D são colocados ao redor do personagem.

- [English](#english)
- [Português](#português)

---

## English

### How to run

```bash
pip install -r requirements.txt
python server.py
```

Then open the viewer in the browser, upload a photo, and test the environment live. Export to GLB, OBJ, FBX or `.blend` is only offered after the live test is approved.

### Environment types

The classifier reads a photo and returns one of 11 contexts. It uses only colour, texture and the position of each region in the image (top third, middle, bottom half). It does not understand what objects are in the scene.

| Context | Recognized scenes | 3D objects placed |
|---|---|---|
| `indoor` | Rooms, studios, lounges, showrooms | Sofa, armchair, coffee table, rug, floor lamp, shelf, indoor plant |
| `cave` | Caves, lava tubes, grottoes | Rocks, stone markers, a few lamps. No trees. |
| `snow` | Snowy landscapes, mountain cabins | Log cabins, snowy pines, snowmen, rocks, fences, benches, lamps |
| `forest` | Forest trails, boardwalks, dirt paths under dense canopy | Trees, pines, bushes, rocks, fences, bench |
| `tropical` | Dense tropical vegetation, pools, leisure houses | Houses, pool, pergola, loungers, palms, banana plants, trees, bushes |
| `beach` | Sand, sea, palms, umbrellas, beach bars | Palms, rocks, umbrellas, loungers, beach hut, boat, life ring, benches, lamps, bushes |
| `alpine` | Stone and rock, mountain huts | A-frame hut, rocks, cairns, pines, bushes, bench |
| `suburban` | Terracotta roofs and little vegetation | Row houses, concrete poles, cars, hedges, trees, palms, fences, bench |
| `urban` | Streets, facades, asphalt, paved sidewalks | Buildings, cars, lamps, benches, hedges, trees, rocks, fences |
| `rural` | Fields, farms, gardens with grass | Houses, barn, trees, pines, bushes and other rural objects |
| `mixed` | Scenes without a clear signal (fallback) | Same as `rural` |

### Analysis criteria

Values are fractions of pixels that match each condition. "Top" means the upper third of the image, "bottom" the lower third, and "lower half" the bottom 50%. Photos are reduced to 320 px before analysis.

The rules run in this order. The first rule that matches decides the context.

1. **`snow`** (early check): more than 40% of the bottom third is cool white (bottom mean of blue minus red ≥ −10). This runs before `indoor` so an overcast sky over snow is not taken for a ceiling.
2. **`indoor`**: more than 25% of the top third is smooth and light (texture ≤ 6, brightness > 0.45), less than 10% is blue sky, less than 5% of the bottom third is green, total green is below 10%, and the floor is warm (bottom mean of blue minus red < −12).
3. **`cave`**: more than 35% of the top third is dark (brightness < 0.35), less than 12% is blue sky, total green is below 10%, and more than 35% of the lower half has rock texture.
4. **`snow`** (general): more than 35% of the lower half is snow-coloured.
5. **`forest`**: (more than 35% green in the top third, OR more than 30% dark green or dark brown along the left and right edges above 67% of the height) AND total green above 20% AND green in the bottom third below 50% AND water below 4% AND brown (soil or wood) in the bottom third above 2%.
6. **`tropical`**: vivid green above 25% in the middle band, OR total green above 32% with water above 4% or terracotta above 2%.
7. **`suburban`**: terracotta (red roofs or red soil) above 5% in the middle band AND total green below 18%.
8. **`alpine`**: textured grey rock above 30% in the lower half, dark below 25%, green below 10%, water below 8%.
9. **`beach`**: any of these, AND total green below 25%:
   - water in the lower half above 10%;
   - sand above 25% with water above 2%, or sand above 20% with water above 3%;
   - sand above 8% with water above 3%, green below 15% and rock below 20%;
   - pale sea (blue-grey, low saturation) above 15% with sand above 12% or pale sand above 12%;
   - sand above 30% in the lower half with dark below 15% and total green below 10% (sea farther from the camera).
10. **`urban`**: dark or grey above 30% in the lower half, green below 12%, water below 8%, AND one of: smooth asphalt above 15%, textured stone above 15%, or paved sidewalk above 20%.
11. **`rural`**: green in the lower half above 8%, OR total green above 15%.
12. **`mixed`**: anything left over.

Colour masks, in HSV space: green covers hue 65–170° with saturation above 0.18, including dark greens (pines). Water covers hue 155–225° with saturation 0.20–0.65 (the upper limit excludes tents and cars). Terracotta covers hue below 20° or above 350° with saturation above 0.45. Sand covers hue 25–55° with saturation 0.18–0.55 and brightness above 0.60.

### Ground line

`detect_ground_row` finds the row where the open ground starts. It counts green, dark pixels (below luminance 75) and brown soil or wood in the lower 40% of the image. If the ground does not cover at least 15% of the image or sits above the horizon, it returns no ground line, and the scene uses a generic floor cut from the bottom of the photo.

### Known limitations

- Night photos with blue shadows on snow are classified as `beach`, because blue shadows look like sea.
- Bright, pale sand under a strong overcast sky is sometimes classified as `mixed`.
- Caves with an opening to the sky can be classified as `mixed` or `rural`.
- Warm sunset photos can drop into `urban`, because the warm light makes the sand dark.
- Interiors with a green wall of plants may be classified as `alpine` or `tropical`.
- The classifier has no semantic understanding: a painted scene or a poster can be classified as the environment it depicts.

### Project structure

- `server.py`: Flask server. Receives the photo, classifies the environment, generates depth and the 3D files.
- `scene_assets.py`: environment classifier (`sample_context`) and ground detection (`detect_ground_row`).
- `depth.py`, `mesh_builder.py`, `panorama.py`, `photo_enhance.py`: depth estimation and mesh generation.
- `viewer/js/library.js`: procedural 3D objects and the `scatter()` function that places them per context.
- `viewer/js/`: scene, physics (Rapier), character and UI.

---

## Português

### Como rodar

```bash
pip install -r requirements.txt
python server.py
```

Depois abra o visualizador no navegador, envie uma foto e teste o ambiente ao vivo. A exportação para GLB, OBJ, FBX ou `.blend` só é oferecida depois que o teste ao vivo for aprovado.

### Tipos de ambiente

O classificador lê a foto e devolve um de 11 contextos. Ele usa só cor, textura e a posição de cada região na imagem (terço superior, meio, metade de baixo). Não entende quais objetos existem na cena.

| Contexto | Cenas reconhecidas | Objetos 3D colocados |
|---|---|---|
| `indoor` | Salas, ateliês, lounges, showrooms | Sofá, poltrona, mesa de centro, tapete, luminária de piso, estante, planta de interior |
| `cave` | Cavernas, tubos de lava, grutas | Pedras, marcos de pedra, algumas luzes. Sem árvores. |
| `snow` | Paisagens nevadas, cabanas de montanha | Cabanas de tronco, pinheiros nevados, bonecos de neve, pedras, cercas, bancos, postes |
| `forest` | Trilhas de floresta, passarelas de madeira, caminhos de terra sob copa densa | Árvores, pinheiros, arbustos, pedras, cerca, banco |
| `tropical` | Vegetação tropical densa, piscinas, casas de lazer | Casa, piscina, pérgola, espreguiçadeiras, palmeiras, bananeiras, árvores, arbustos |
| `beach` | Areia, mar, palmeiras, guarda-sóis, quiosques de praia | Palmeiras, pedras, guarda-sóis, espreguiçadeiras, quiosque, barco, boia salva-vidas, bancos, postes, arbustos |
| `alpine` | Pedra e rocha, refúgios de montanha | Refúgio A-frame, pedras, marcos de pedra, pinheiros, arbustos, banco |
| `suburban` | Telhados de telha e pouca vegetação | Casinhas de loteamento, postes de concreto, carros, sebes, árvores, palmeiras, cercas, banco |
| `urban` | Ruas, fachadas, asfalto, calçadas | Prédios, carros, postes, bancos, sebes, árvores, pedras, cercas |
| `rural` | Campos, fazendas, jardins com gramado | Casas, celeiro, árvores, pinheiros, arbustos e outros objetos rurais |
| `mixed` | Cenas sem sinal claro (contexto padrão) | Igual a `rural` |

### Critérios de análise

Os valores são frações de pixels que atendem a cada condição. "Topo" é o terço superior da imagem, "embaixo" é o terço inferior, e "metade de baixo" são os 50% de baixo. A foto é reduzida para 320 px antes da análise.

As regras são avaliadas nesta ordem. A primeira que bater decide o contexto.

1. **`snow`** (verificação antecipada): mais de 40% do terço de baixo é branco frio (média de azul menos vermelho ≥ −10). Roda antes de `indoor` para que um céu nublado sobre neve não seja confundido com teto.
2. **`indoor`**: mais de 25% do topo é liso e claro (textura ≤ 6, brilho > 0,45), menos de 10% é céu azul, menos de 5% do chão é verde, verde total abaixo de 10%, e o chão é quente (média de azul menos vermelho < −12).
3. **`cave`**: mais de 35% do topo é escuro (brilho < 0,35), menos de 12% é céu azul, verde total abaixo de 10%, e mais de 35% da metade de baixo tem textura de rocha.
4. **`snow`** (geral): mais de 35% da metade de baixo tem cor de neve.
5. **`forest`**: (mais de 35% de verde no topo, OU mais de 30% de verde escuro ou marrom escuro nas laterais, acima de 67% da altura) E verde total acima de 20% E verde embaixo abaixo de 50% E água abaixo de 4% E marrom (terra ou madeira) embaixo acima de 2%.
6. **`tropical`**: verde vivo acima de 25% na faixa do meio, OU verde total acima de 32% com água acima de 4% ou terracota acima de 2%.
7. **`suburban`**: terracota (telhado vermelho ou terra vermelha) acima de 5% na faixa do meio E verde total abaixo de 18%.
8. **`alpine`**: rocha cinza texturizada acima de 30% na metade de baixo, escuro abaixo de 25%, verde abaixo de 10%, água abaixo de 8%.
9. **`beach`**: qualquer uma destas, E verde total abaixo de 25%:
   - água na metade de baixo acima de 10%;
   - areia acima de 25% com água acima de 2%, ou areia acima de 20% com água acima de 3%;
   - areia acima de 8% com água acima de 3%, verde abaixo de 15% e rocha abaixo de 20%;
   - mar pálido (cinza-azulado, pouca saturação) acima de 15% com areia acima de 12% ou areia clara acima de 12%;
   - areia acima de 30% na metade de baixo, com escuro abaixo de 15% e verde total abaixo de 10% (mar mais longe da câmera).
10. **`urban`**: escuro ou cinza acima de 30% na metade de baixo, verde abaixo de 12%, água abaixo de 8%, E um destes: asfalto liso acima de 15%, pedra texturizada acima de 15%, ou calçada acima de 20%.
11. **`rural`**: verde na metade de baixo acima de 8%, OU verde total acima de 15%.
12. **`mixed`**: o que sobrar.

Máscaras de cor, no espaço HSV: o verde cobre matiz de 65° a 170° com saturação acima de 0,18, incluindo verdes escuros (pinheiros). A água cobre matiz de 155° a 225° com saturação de 0,20 a 0,65 (o limite superior exclui tendas e carros). A terracota cobre matiz abaixo de 20° ou acima de 350° com saturação acima de 0,45. A areia cobre matiz de 25° a 55° com saturação de 0,18 a 0,55 e brilho acima de 0,60.

### Linha do chão

`detect_ground_row` encontra a linha onde começa o chão aberto. Ela conta pixels verdes, pixels escuros (luminância abaixo de 75) e terra ou madeira marrom nos 40% de baixo da foto. Se o chão não cobrir pelo menos 15% da imagem ou estiver acima do horizonte, não há linha do chão, e a cena usa um piso genérico recortado da parte de baixo da foto.

### Limitações conhecidas

- Fotos noturnas com sombra azul na neve são classificadas como `beach`, porque a sombra azul parece mar.
- Areia clara sob céu nublado forte às vezes sai como `mixed`.
- Cavernas com abertura para o céu podem sair como `mixed` ou `rural`.
- Fotos de pôr do sol quente podem cair em `urban`, porque a luz quente escurece a areia.
- Interiores com parede verde de plantas podem sair como `alpine` ou `tropical`.
- O classificador não tem entendimento semântico: uma pintura ou um pôster pode ser classificado pelo ambiente que retrata.

### Estrutura do projeto

- `server.py`: servidor Flask. Recebe a foto, classifica o ambiente e gera a profundidade e os arquivos 3D.
- `scene_assets.py`: classificador de ambiente (`sample_context`) e detecção do chão (`detect_ground_row`).
- `depth.py`, `mesh_builder.py`, `panorama.py`, `photo_enhance.py`: estimativa de profundidade e geração da malha.
- `viewer/js/library.js`: objetos 3D procedurais e a função `scatter()` que os coloca por contexto.
- `viewer/js/`: cena, física (Rapier), personagem e interface.


## Reconstrução semântica avançada (local e nuvem)

A geração agora possui uma etapa opcional de segmentação semântica com **Mask2Former**. Ela identifica regiões como edifícios, árvores, vegetação, caminhos e céu, grava máscaras PNG por classe e usa a máscara de edifício para produzir o recorte da fachada. Se o modelo ou o serviço remoto falhar, a geração continua pelo método OpenCV anterior.

### Modos de execução

Configure as variáveis de ambiente antes de iniciar `python server.py`:

| Variável | Valores | Função |
|---|---|---|
| `PHOTO2GAME_AI_MODE` | `auto`, `local`, `cloud` | Seleciona o backend semântico. |
| `PHOTO2GAME_SEGMENTATION_MODEL` | ID de modelo Hugging Face | Permite substituir o modelo padrão. |
| `HF_TOKEN` | token Hugging Face | Autenticação para inferência na nuvem. |

**Local (padrão sem token):**

```powershell
$env:PHOTO2GAME_AI_MODE = "local"
pip install -r requirements.txt
python server.py
```

Na primeira execução, Transformers baixa o modelo e mantém os pesos no cache local. O modelo padrão é `facebook/mask2former-swin-large-coco-panoptic`; recomenda-se GPU NVIDIA para reduzir o tempo de inferência. Em CPU, a primeira execução e imagens grandes podem demorar.

**Nuvem (Hugging Face Inference):**

```powershell
$env:PHOTO2GAME_AI_MODE = "cloud"
$env:HF_TOKEN = "hf_seu_token"
python server.py
```

O token deve ter permissão para usar os modelos de inferência. O provedor/modelo precisa oferecer a tarefa de segmentação de imagem. O conteúdo da foto é enviado ao serviço remoto nesse modo.

**Automático:**

```powershell
$env:PHOTO2GAME_AI_MODE = "auto"
$env:HF_TOKEN = "hf_seu_token" # opcional; com token, prioriza nuvem
python server.py
```

Consulte `GET /api/status` para verificar o backend selecionado, disponibilidade local/remota e modelo configurado.

### O que muda no pipeline

- A segmentação semântica é executada após o pré-processamento da fotografia.
- Máscaras são armazenadas em `projects/<id>/semantica/` e descritas em `meta.json` no campo `ai_scene`.
- A fachada usa o recorte da máscara de edifício, preservando a silhueta segmentada; quando não existe máscara adequada, o recorte OpenCV continua como fallback.
- A textura de chão não é mais repetida em ladrilhos pelo mapa.
- Árvores detectadas não são clonadas para preencher artificialmente o perímetro.
- O proxy de fachada tem profundidade reduzida, evitando uma caixa exagerada com uma única fotografia aplicada na face frontal.

> Limitação geométrica: uma única foto não revela as laterais, o fundo ou a geometria oculta da construção. A segmentação melhora a separação dos objetos, mas não substitui fotogrametria multi-view nem garante uma reconstrução volumétrica exata. O viewer, a física Rapier e a exportação continuam usando o pipeline Three.js/GLB existente.


## Reconstrução volumétrica de edificações

Quando a segmentação semântica encontra uma máscara de edifício, o backend também executa `building_reconstruction.py` e gera `semantica/edificacao_volumetrica.glb`. O GLB contém componentes geométricos separados:

- paredes laterais e traseira, laje/fundação;
- duas águas de telhado, cumeeira e beiral;
- fachada frontal com material derivado da fotografia;
- volumes de porta, batentes e maçaneta quando a análise de contornos identifica uma entrada;
- volumes de vidro, caixilhos e divisórias quando são identificadas regiões semelhantes a janelas.

O visualizador carrega esse GLB como uma edificação, aplica sombras e cria colisores com o sistema Rapier. A exportação da cena continua usando o GLB completo do viewer.

**Importante:** em uma única fotografia, as faces laterais e traseiras, o interior e as superfícies ocultas não podem ser observados diretamente. O sistema estima essas partes proceduralmente a partir da fachada e da escala projetada. A detecção de portas e janelas é heurística e deve ser validada em fotografias variadas; ela não equivale a um levantamento arquitetônico ou a uma reconstrução fotogramétrica multi-view.

## Inicialização pelo Windows

Execute `iniciar_photo2game3d.bat` com duplo clique. O menu permite selecionar:

1. **Local:** define `PHOTO2GAME_AI_MODE=local`, instala/verifica as dependências e executa o servidor. Os modelos são baixados no primeiro uso.
2. **Nuvem:** solicita um token Hugging Face, define `PHOTO2GAME_AI_MODE=cloud` e executa o servidor. O token fica apenas no ambiente do processo e não é gravado no arquivo BAT.

Também é possível configurar manualmente as variáveis de ambiente e executar `python server.py`.


## Motores Image-to-3D: InstantMesh + Hunyuan3D

O Photo2Game3D pode usar motores especializados para substituir billboards e proxies por malhas 3D reais:

- **InstantMesh**: árvores e objetos isolados (mobiliário, veículos, animais e outros elementos detectados) extraídos pela segmentação semântica. Processa até quatro árvores e quatro objetos por fotografia por padrão (`PHOTO2GAME_MAX_INSTANTMESH_TREES` e `PHOTO2GAME_MAX_INSTANTMESH_OBJECTS`); se o modelo falhar, mantém o billboard segmentado.
- **Hunyuan3D**: fachada isolada da edificação enviada ao serviço Image-to-3D com geração de textura habilitada. O GLB gerado é dimensionado e posicionado no viewer. Se a API falhar, a reconstrução procedural e o recorte OpenCV continuam disponíveis.
- **Viewer**: carrega os GLBs gerados, mantém o sistema Three.js/Rapier e inclui as malhas na exportação da cena.

### Dependências separadas

Os dois projetos têm pilhas de ML grandes e versões de PyTorch/CUDA próprias. Por isso, o Photo2Game3D não instala todos os pacotes deles no ambiente Flask principal. Os motores são chamados por subprocesso ou API HTTP.

#### InstantMesh local

1. Clone o repositório oficial em uma pasta separada: `https://github.com/TencentARC/InstantMesh`.
2. Prepare o ambiente recomendado pelo projeto (Python 3.10, PyTorch 2.1, CUDA 12.1 e xformers compatível).
3. Configure:

```powershell
$env:PHOTO2GAME_3D_MODE = "local"
$env:INSTANTMESH_DIR = "D:\AI\InstantMesh"
$env:INSTANTMESH_PYTHON = "D:\AI\envs\instantmesh\python.exe"
$env:INSTANTMESH_CONFIG = "configs/instant-mesh-large.yaml"
```

O adaptador chama `run.py` com `--no_rembg --export_texmap`, converte o OBJ texturizado para GLB e guarda o resultado dentro do projeto gerado.

#### Hunyuan3D local

1. Clone o repositório oficial: `https://github.com/Tencent-Hunyuan/Hunyuan3D-2`.
2. Instale suas dependências em um ambiente Python próprio, seguindo a documentação oficial.
3. Inicie a API local. O BAT pode fazer isso se você informar a pasta do repositório e o executável Python:

```powershell
python api_server.py --host 127.0.0.1 --port 8081 --enable_tex
```

4. O Photo2Game3D chama `http://127.0.0.1:8081/generate`, envia a imagem em base64 com `texture=true` e recebe o GLB.

A documentação do Hunyuan3D indica aproximadamente 6 GB de VRAM para geração de forma e 16 GB para geração de forma + textura. A disponibilidade real depende do modelo, resolução e configuração.

#### Modo nuvem

Defina endpoints acessíveis por HTTPS:

```powershell
$env:PHOTO2GAME_3D_MODE = "cloud"
$env:HUNYUAN3D_API_URL = "https://seu-servidor-hunyuan/generate"
$env:HUNYUAN3D_API_TOKEN = "token-opcional"
$env:INSTANTMESH_API_URL = "https://seu-servidor-instantmesh/generate"
$env:INSTANTMESH_API_TOKEN = "token-opcional"
```

O endpoint Hunyuan3D deve seguir a API oficial: POST JSON com `image` em base64 e parâmetros como `type: "glb"` e `texture: true`; resposta deve ser um GLB binário ou JSON com `model_base64`/`glb_base64`.

**InstantMesh não possui um provedor oficial de inferência hospedada publicado no model card.** Para o modo nuvem, é necessário hospedar um pequeno adaptador HTTP próprio que aceite `multipart/form-data` no campo `image` e retorne um GLB binário (ou JSON com `glb_base64`). Não há endpoint de nuvem da Tencent configurado automaticamente.

### Variáveis e diagnóstico

| Variável | Finalidade |
|---|---|
| `PHOTO2GAME_3D_MODE` | `local`, `cloud` ou `off` para motores 3D |
| `INSTANTMESH_DIR` | Checkout local do InstantMesh |
| `INSTANTMESH_PYTHON` | Python do ambiente InstantMesh |
| `INSTANTMESH_API_URL` | Endpoint HTTP de InstantMesh na nuvem |
| `HUNYUAN3D_API_URL` | Endpoint `/generate` do Hunyuan3D |
| `HUNYUAN3D_API_TOKEN` | Token Bearer opcional |
| `PHOTO2GAME_MAX_INSTANTMESH_TREES` | Limite de árvores processadas por imagem (padrão 4) |
| `PHOTO2GAME_MAX_INSTANTMESH_OBJECTS` | Limite de objetos não arbóreos processados por imagem (padrão 4) |

`GET /api/status` expõe configuração e disponibilidade declarada dos motores. Uma API remota configurada não significa que o serviço esteja saudável; confirme também o endpoint do modelo.

### Limitações, licenças e fidelidade

InstantMesh é um reconstrutor de objetos de imagem única, não um segmentador de árvores: a segmentação do Photo2Game3D fornece o recorte de cada árvore antes da reconstrução. Hunyuan3D gera uma malha condicionada pela imagem e textura, mas não garante fidelidade arquitetônica exata nem recupera faces ocultas. Para edifícios, o resultado deve ser tratado como uma hipótese 3D inferida; fachadas, aberturas, telhado e escala precisam de validação.

Consulte os termos oficiais antes de distribuir ou usar comercialmente os pesos e serviços. Em particular, o Hunyuan3D é distribuído sob a Tencent Hunyuan Community License, com condições próprias e restrições de uso comercial. A licença Apache-2.0 do InstantMesh não altera os termos dos pesos/dados de terceiros que ele utiliza.
