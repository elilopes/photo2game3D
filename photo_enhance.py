"""photo_enhance.py — pré-processamento da foto antes de entrar na pipeline 3D.

Duas operações, cada uma com 3 níveis de qualidade (melhor disponível):

1. Melhora de Resolução (super_resolve)
   Nível A — Real-ESRGAN ONNX  (models/realesrgan_x4.onnx, ~65 MB)
             Upscale 4× com detalhe neural realista em grama/textura/árvores.
   Nível B — cv2.dnn.readNetFromOnnx com EDSR-mini  (models/EDSR_x3.pb, ~6 MB)
             Upscale 3× via OpenCV DNN (pré-treinado pela equipe OpenCV).
   Nível C — PIL LANCZOS  (sem peso algum, sempre disponível)
             Bicúbico 2× — aumenta resolução sem detalhe extra, útil para garantir
             que a textura do piso/panorama não fica granulada.

2. Melhora de Iluminação (enhance_light)
   Nível A — SCI ONNX  (models/sci_medium.onnx, ~8 MB)
             Self-Calibrated Illuminant — recupera sombras escuras preservando as
             altas luzes, ideal para fotos de interior ou dia nublado.
   Nível B — OpenCV CLAHE (Contrast Limited AHE)
             Equilíbrio local de histograma no canal L do espaço LAB — sem peso,
             melhora visivelmente fotos sub-expostas ou de baixa luminosidade.
   Nível C — Sem alteração (foto já bem iluminada)

Configuração por variável de ambiente:
   PHOTO2GAME_ENHANCE=off          desativa tudo
   PHOTO2GAME_ENHANCE=light_only   só melhora de luz (mais rápido)
   PHOTO2GAME_SUPERRES=off         desativa só super-resolução
   PHOTO2GAME_LIGHT=off            desativa só melhora de luz
   PHOTO2GAME_MODELS=./models      pasta onde ficam os arquivos .onnx / .pb

Pesos recomendados:
   Real-ESRGAN: https://github.com/xinntao/Real-ESRGAN/releases
     → realesr-general-x4v3.pth  (converter para ONNX com export_onnx.py)
     → Ou baixar diretamente o ONNX convertido pela comunidade:
       https://huggingface.co/onnx-community/Real-ESRGAN  (Apache 2.0)
   EDSR-mini:   https://github.com/Saafke/EDSR_Tensorflow/tree/master/models
     → EDSR_x3.pb (6 MB, OpenCV DNN)
   SCI:         https://github.com/vis-opt-group/SCI
     → Exportar ONNX com torch.onnx.export no modelo SCI "medium"
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image, ImageEnhance

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuração
# ---------------------------------------------------------------------------
_MODELS_DIR = Path(os.environ.get("PHOTO2GAME_MODELS", Path(__file__).parent / "models"))
_ENHANCE_MODE = os.environ.get("PHOTO2GAME_ENHANCE", "auto").lower()   # off | light_only | auto
_DO_SUPERRES = os.environ.get("PHOTO2GAME_SUPERRES", "auto").lower() != "off" and _ENHANCE_MODE != "off"
_DO_LIGHT    = os.environ.get("PHOTO2GAME_LIGHT",    "auto").lower() != "off" and _ENHANCE_MODE != "off"

# Thresholds que decidem se a operação é necessária
_MIN_SHORT_SIDE_FOR_SKIP = 1024   # fotos já > 1024 px no lado menor não são upscaladas
_MIN_BRIGHTNESS_SKIP     = 90     # brilho médio acima de 90/255 → não aplica melhora de luz

# ---------------------------------------------------------------------------
# Lazy‑load helpers para evitar importação desnecessária
# ---------------------------------------------------------------------------
def _try_import(name: str):
    try:
        import importlib
        return importlib.import_module(name)
    except ImportError:
        return None


def _load_onnx_session(model_name: str):
    """Retorna uma ort.InferenceSession ou None se indisponível."""
    path = _MODELS_DIR / model_name
    if not path.exists():
        return None
    ort = _try_import("onnxruntime")
    if ort is None:
        log.warning("onnxruntime não instalado — %s não será usado.", model_name)
        return None
    try:
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        sess = ort.InferenceSession(str(path), providers=providers)
        log.info("ONNX '%s' carregado (%s).", model_name, sess.get_providers()[0])
        return sess
    except Exception as exc:
        log.warning("Falha ao carregar ONNX '%s': %s", model_name, exc)
        return None


# ---------------------------------------------------------------------------
# 1. Super-resolução
# ---------------------------------------------------------------------------

def _superres_onnx(img: np.ndarray, sess) -> Optional[np.ndarray]:
    """Real-ESRGAN ONNX.  Entrada/saída: uint8 HWC RGB."""
    try:
        # (H, W, 3) → (1, 3, H, W) float32 [0, 1]
        x = img.astype(np.float32) / 255.0
        x = np.transpose(x, (2, 0, 1))[None]
        iname = sess.get_inputs()[0].name
        y = sess.run(None, {iname: x})[0]           # (1, 3, 4H, 4W)
        y = np.clip(y[0].transpose(1, 2, 0) * 255, 0, 255).astype(np.uint8)
        return y
    except Exception as exc:
        log.warning("Real-ESRGAN ONNX falhou: %s", exc)
        return None


def _superres_dnn(img_pil: Image.Image) -> Optional[Image.Image]:
    """OpenCV DNN EDSR — requer EDSR_x3.pb."""
    cv2 = _try_import("cv2")
    if cv2 is None:
        return None
    pb = _MODELS_DIR / "EDSR_x3.pb"
    if not pb.exists():
        return None
    try:
        sr = cv2.dnn_superres.DnnSuperResImpl_create()
        sr.readModel(str(pb))
        sr.setModel("edsr", 3)
        bgr = cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)
        out = sr.upsample(bgr)
        rgb = cv2.cvtColor(out, cv2.COLOR_BGR2RGB)
        return Image.fromarray(rgb)
    except Exception as exc:
        log.warning("EDSR DNN falhou: %s", exc)
        return None


def _superres_lanczos(img_pil: Image.Image, factor: float = 2.0) -> Image.Image:
    """Fallback Lanczos puro (PIL)."""
    w, h = img_pil.size
    return img_pil.resize((int(w * factor), int(h * factor)), Image.LANCZOS)


_esrgan_sess = None
_esrgan_tried = False


def super_resolve(img: Image.Image) -> Image.Image:
    """Aumenta a resolução da foto se ela for pequena.
    Retorna a imagem original caso já seja grande o suficiente.
    """
    if not _DO_SUPERRES:
        return img

    w, h = img.size
    short = min(w, h)
    if short >= _MIN_SHORT_SIDE_FOR_SKIP:
        return img   # já tem resolução adequada

    log.info("super_resolve: %dx%d → tentando upscale.", w, h)

    # Nível A — ONNX
    global _esrgan_sess, _esrgan_tried
    if not _esrgan_tried:
        _esrgan_tried = True
        _esrgan_sess = _load_onnx_session("realesrgan_x4.onnx")

    if _esrgan_sess is not None:
        arr = np.array(img.convert("RGB"))
        result = _superres_onnx(arr, _esrgan_sess)
        if result is not None:
            log.info("super_resolve: Real-ESRGAN OK → %dx%d", result.shape[1], result.shape[0])
            return Image.fromarray(result)

    # Nível B — OpenCV DNN EDSR
    result_pil = _superres_dnn(img)
    if result_pil is not None:
        log.info("super_resolve: EDSR DNN OK → %dx%d", *result_pil.size)
        return result_pil

    # Nível C — Lanczos
    factor = max(1.5, _MIN_SHORT_SIDE_FOR_SKIP / short)
    result_pil = _superres_lanczos(img, factor)
    log.info("super_resolve: Lanczos ×%.1f → %dx%d", factor, *result_pil.size)
    return result_pil


# ---------------------------------------------------------------------------
# 2. Melhora de Iluminação
# ---------------------------------------------------------------------------

def _mean_brightness(img: Image.Image) -> float:
    """Brilho médio 0–255 calculado a partir do canal L do espaço LAB."""
    cv2 = _try_import("cv2")
    if cv2 is not None:
        lab = cv2.cvtColor(np.array(img.convert("RGB")), cv2.COLOR_RGB2LAB)
        return float(lab[..., 0].mean())
    # Fallback: média simples dos canais RGB
    arr = np.array(img.convert("RGB"), dtype=np.float32)
    return float(arr.mean())


def _light_onnx(img: np.ndarray, sess) -> Optional[np.ndarray]:
    """SCI ONNX.  Entrada/saída: uint8 HWC RGB."""
    try:
        x = img.astype(np.float32) / 255.0
        x = np.transpose(x, (2, 0, 1))[None]
        iname = sess.get_inputs()[0].name
        y = sess.run(None, {iname: x})[0]
        y = np.clip(y[0].transpose(1, 2, 0) * 255, 0, 255).astype(np.uint8)
        return y
    except Exception as exc:
        log.warning("SCI ONNX falhou: %s", exc)
        return None


def _light_clahe(img: Image.Image) -> Optional[Image.Image]:
    """CLAHE no canal L do espaço LAB — requer OpenCV."""
    cv2 = _try_import("cv2")
    if cv2 is None:
        return None
    try:
        lab = cv2.cvtColor(np.array(img.convert("RGB")), cv2.COLOR_RGB2LAB)
        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
        lab[..., 0] = clahe.apply(lab[..., 0])
        rgb = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)
        return Image.fromarray(rgb)
    except Exception as exc:
        log.warning("CLAHE falhou: %s", exc)
        return None


def _light_pil(img: Image.Image) -> Image.Image:
    """Melhora leve via PIL — sem dependências extras."""
    img = ImageEnhance.Brightness(img).enhance(1.25)
    img = ImageEnhance.Contrast(img).enhance(1.15)
    return img


_sci_sess = None
_sci_tried = False


def enhance_light(img: Image.Image) -> Image.Image:
    """Clareia fotos escuras.  Não aplica nada em fotos já bem iluminadas."""
    if not _DO_LIGHT:
        return img

    brightness = _mean_brightness(img)
    if brightness >= _MIN_BRIGHTNESS_SKIP:
        return img   # já está bem iluminada

    log.info("enhance_light: brilho médio %.1f — aplicando melhora.", brightness)

    # Nível A — ONNX
    global _sci_sess, _sci_tried
    if not _sci_tried:
        _sci_tried = True
        _sci_sess = _load_onnx_session("sci_medium.onnx")

    if _sci_sess is not None:
        arr = np.array(img.convert("RGB"))
        result = _light_onnx(arr, _sci_sess)
        if result is not None:
            log.info("enhance_light: SCI ONNX OK.")
            return Image.fromarray(result)

    # Nível B — CLAHE
    result_pil = _light_clahe(img)
    if result_pil is not None:
        log.info("enhance_light: CLAHE OK.")
        return result_pil

    # Nível C — PIL simples
    log.info("enhance_light: PIL fallback.")
    return _light_pil(img)


# ---------------------------------------------------------------------------
# API pública
# ---------------------------------------------------------------------------

def preprocess(img: Image.Image) -> Image.Image:
    """Aplica super_resolve + enhance_light em sequência.
    Sempre retorna uma imagem RGB.  Sem exceção: na pior das hipóteses devolve
    a imagem original intacta.
    """
    if _ENHANCE_MODE == "off":
        return img.convert("RGB")
    try:
        img = img.convert("RGB")
        img = super_resolve(img)
        img = enhance_light(img)
        return img
    except Exception as exc:
        log.warning("photo_enhance.preprocess falhou completamente: %s", exc)
        return img.convert("RGB")


def available_enhancements() -> dict:
    """Retorna quais métodos estão disponíveis (para /api/status)."""
    ort = _try_import("onnxruntime")
    cv2 = _try_import("cv2")
    has_esrgan = (_MODELS_DIR / "realesrgan_x4.onnx").exists() and ort is not None
    has_edsr   = (_MODELS_DIR / "EDSR_x3.pb").exists() and cv2 is not None
    has_sci    = (_MODELS_DIR / "sci_medium.onnx").exists() and ort is not None

    if has_esrgan:
        sr = "Real-ESRGAN ONNX"
    elif has_edsr:
        sr = "EDSR OpenCV DNN"
    else:
        sr = "Lanczos (fallback)"

    if has_sci:
        light = "SCI ONNX"
    elif cv2 is not None:
        light = "CLAHE OpenCV"
    else:
        light = "PIL (fallback)"

    return {"super_resolve": sr if _DO_SUPERRES else "off",
            "enhance_light": light if _DO_LIGHT else "off"}
