"""SigLIP2 embedding service — the perception layer of the pipeline."""

import io
import logging

import torch
from PIL import Image
from transformers import AutoModel, AutoProcessor

from app.models.facets import FACET_VOCABULARIES, FacetProfile

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "google/siglip2-base-patch16-224"
PROMPT_TEMPLATE = "This is a photo of {tag}."

# Per-facet rejection anchors: "none of this facet's tags really apply".
# A forced top-k pick from a facet's vocab always returns *something*, even
# on an image where the concept isn't present (no "material" or "shape" in
# a landscape photo). A single shared anchor doesn't work here — different
# facets have different baseline applicability (a landscape photo generally
# scores lower against *any* forced tag than a staged product photo would),
# so one generic anchor either over-rejects facets that do apply (style on
# a city skyline) or under-rejects ones that don't (material on a forest).
# Each facet gets its own anchor describing the absence of that specific
# concept, phrased through the same PROMPT_TEMPLATE structure so the
# comparison is apples-to-apples (a structurally different sentence embeds
# into an unrelated region purely from syntax and silently always loses).
FACET_NULL_HINTS: dict[str, str] = {
    "style": "no distinct aesthetic style",
    "terrain": "no natural landscape or terrain",
    "locale": "no identifiable built environment or landmark",
    "shape": "no distinct object shape or silhouette",
    "material": "no distinct surface material",
    "quality": "no strong mood or atmosphere",
}
DEFAULT_NULL_HINT = "nothing distinctive"


class EmbeddingService:
    """SigLIP2-based image embedding and zero-shot facet classification.

    Uses sigmoid scoring with the model's learned logit_scale and logit_bias,
    matching SigLIP2's training objective (independent sigmoid loss).
    Each label gets an independent yes/no probability — no softmax
    competition across labels.
    """

    def __init__(self, model_name: str = DEFAULT_MODEL, device: str | None = None):
        self.model_name = model_name
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self._model = None
        self._processor = None
        self._text_cache: dict[tuple, tuple[torch.Tensor, torch.Tensor, dict[str, slice]]] = {}

    def _load(self) -> None:
        if self._model is not None:
            return
        logger.info("Loading SigLIP2 model: %s on %s", self.model_name, self.device)
        self._processor = AutoProcessor.from_pretrained(self.model_name)
        self._model = AutoModel.from_pretrained(self.model_name, low_cpu_mem_usage=True).to(self.device).eval()
        self._logit_scale = self._model.logit_scale
        self._logit_bias = self._model.logit_bias
        logger.info("SigLIP2 model loaded. logit_scale=%.4f, logit_bias=%.4f",
                    float(self._logit_scale.detach()), float(self._logit_bias.detach()))

    async def embed_image(self, image_bytes: bytes) -> list[float]:
        """Embed a single image into a feature vector."""
        return (await self.embed_images([image_bytes]))[0]

    async def embed_images(self, images: list[bytes], batch_size: int = 4) -> list[list[float]]:
        """Embed image sets in small batches to avoid a model call per image."""
        if not images:
            return []
        self._load()
        embeddings: list[list[float]] = []
        for start in range(0, len(images), batch_size):
            batch = []
            for content in images[start : start + batch_size]:
                with Image.open(io.BytesIO(content)) as image:
                    batch.append(image.convert("RGB"))
            inputs = self._processor(images=batch, return_tensors="pt").to(self.device)
            with torch.inference_mode():
                output = self._model.get_image_features(**inputs)
                features = torch.nn.functional.normalize(self._features(output), dim=-1)
            embeddings.extend(features.cpu().tolist())
        return embeddings

    @staticmethod
    def _features(output: torch.Tensor) -> torch.Tensor:
        if hasattr(output, "pooler_output"):
            return output.pooler_output
        if hasattr(output, "last_hidden_state"):
            return output.last_hidden_state[:, 0, :]
        return output

    async def classify_facets(
        self,
        image_embedding: list[float],
        vocabularies: dict[str, list[str]] | None = None,
        top_k: int = 3,
    ) -> FacetProfile:
        """Zero-shot classify using sigmoid scoring (not softmax).

        Uses the model's learned logit_scale and logit_bias. Ranking and
        null-anchor comparisons use logits directly because sigmoid is
        monotonic, preserving the original independent-label decisions.

        Returns the top-k tags per facet (ranked by probability) instead of
        forcing a single winner, since a forced top-1 pick is noisy on any
        single image and drops real ambiguity.

        Candidates must also beat that facet's own null-hint anchor to be
        returned at all — otherwise a facet with no real match in the image
        (e.g. "material" on a landscape photo) still forces out its
        least-bad option, which then looks like a confident pick once
        several similar-looking images all force the same wrong answer.
        Each facet's anchor is scoped to that facet's own concept, since a
        single shared anchor either over- or under-rejects depending on how
        readily each facet applies to non-object imagery.
        """
        return (await self.classify_facets_batch([image_embedding], vocabularies, top_k))[0]

    async def classify_facets_batch(
        self,
        image_embeddings: list[list[float]],
        vocabularies: dict[str, list[str]] | None = None,
        top_k: int = 3,
    ) -> list[FacetProfile]:
        """Score all images against cached text features in one matrix multiply."""
        if not image_embeddings:
            return []
        self._load()
        vocabularies = vocabularies or FACET_VOCABULARIES
        text_mat, null_mat, facet_slices = self._get_text_features(vocabularies)
        image_mat = torch.as_tensor(image_embeddings, dtype=text_mat.dtype, device=self.device)
        image_mat = torch.nn.functional.normalize(image_mat, dim=-1)

        with torch.inference_mode():
            logits = (image_mat @ text_mat.T * self._logit_scale + self._logit_bias).cpu()
            null_logits = (image_mat @ null_mat.T * self._logit_scale + self._logit_bias).cpu()

        profiles = []
        for image_idx in range(len(image_embeddings)):
            profile = FacetProfile()
            for facet_idx, (facet, tags) in enumerate(vocabularies.items()):
                if not tags:
                    continue
                scores = logits[image_idx, facet_slices[facet]]
                indices = torch.argsort(scores, descending=True)[:min(top_k, len(tags))]
                anchor = null_logits[image_idx, facet_idx]
                ranked = [tags[int(index)] for index in indices if scores[index] > anchor]
                if ranked:
                    setattr(profile, facet, ranked)
            profiles.append(profile)
        return profiles

    def _get_text_features(
        self, vocabularies: dict[str, list[str]]
    ) -> tuple[torch.Tensor, torch.Tensor, dict[str, slice]]:
        key = tuple((facet, tuple(tags)) for facet, tags in vocabularies.items())
        if key not in self._text_cache:
            prompts = []
            facet_slices = {}
            for facet, tags in vocabularies.items():
                start = len(prompts)
                prompts.extend(PROMPT_TEMPLATE.format(tag=tag) for tag in tags)
                facet_slices[facet] = slice(start, len(prompts))
            null_prompts = [
                PROMPT_TEMPLATE.format(tag=FACET_NULL_HINTS.get(facet, DEFAULT_NULL_HINT))
                for facet in vocabularies
            ]
            features = self._embed_texts(prompts + null_prompts)
            self._text_cache[key] = (features[:len(prompts)], features[len(prompts):], facet_slices)
            logger.info("Cached %d facet text features and %d null anchors", len(prompts), len(null_prompts))
        return self._text_cache[key]

    def _embed_texts(self, texts: list[str], batch_size: int = 64) -> torch.Tensor:
        """Embed text prompts once and retain normalized features on the model device."""
        batches = []
        for i in range(0, len(texts), batch_size):
            batch = texts[i : i + batch_size]
            inputs = self._processor(
                text=batch,
                return_tensors="pt",
                padding="max_length",
                max_length=64,
                truncation=True,
            ).to(self.device)
            with torch.inference_mode():
                output = self._model.get_text_features(**inputs)
                features = torch.nn.functional.normalize(self._features(output), dim=-1)
            batches.append(features)
        return torch.cat(batches)
