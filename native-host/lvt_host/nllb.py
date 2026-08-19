from __future__ import annotations

from pathlib import Path

from .quality import normalize_lang

NLLB_CODES = {
    "en": "eng_Latn",
    "ru": "rus_Cyrl",
}


class NllbTranslator:
    def __init__(self, model_dir: Path, device: str = "cpu") -> None:
        import ctranslate2
        import sentencepiece as spm

        self._sp = spm.SentencePieceProcessor()
        spm_path = model_dir / "sentencepiece.bpe.model"
        if not spm_path.is_file():
            raise FileNotFoundError(spm_path)
        self._sp.load(str(spm_path))
        self._translator = ctranslate2.Translator(str(model_dir), device=device)

    def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        src = NLLB_CODES.get(normalize_lang(source_lang), "eng_Latn")
        tgt = NLLB_CODES.get(normalize_lang(target_lang), "rus_Cyrl")
        pieces = [src] + list(self._sp.encode(text, out_type=str)) + ["</s>"]
        result = self._translator.translate_batch([pieces], target_prefix=[[tgt]], beam_size=1)
        tokens = [tok for tok in result[0].hypotheses[0] if tok not in {tgt, "</s>"}]
        decoded = self._sp.decode(tokens).strip()
        if not decoded:
            raise RuntimeError("translator returned empty text")
        return decoded
