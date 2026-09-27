"""Vibe detection route — image upload → embedding → aggregation → vibe phrase."""

import logging

import httpx
from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.models.facets import FACET_VOCABULARIES
from app.models.vibe import VibeResult
from app.services.aggregation import AggregationService
from app.services.color import get_color_names
from app.services.embedding import EmbeddingService

logger = logging.getLogger(__name__)

router = APIRouter()

_embedding_service: EmbeddingService | None = None
_aggregation_service: AggregationService | None = None


def get_embedding_service() -> EmbeddingService:
    global _embedding_service
    if _embedding_service is None:
        _embedding_service = EmbeddingService()
    return _embedding_service


def get_aggregation_service() -> AggregationService:
    global _aggregation_service
    if _aggregation_service is None:
        _aggregation_service = AggregationService()
    return _aggregation_service


class AnalyzeResponse(BaseModel):
    vibe: VibeResult


class AnalyzeUrlsRequest(BaseModel):
    """Request body for analyzing images already hosted elsewhere.

    Meant for service-to-service calls (e.g. the Next.js backend passing
    Supabase Storage URLs) that shouldn't have to re-upload raw image bytes.
    """

    image_urls: list[str] = Field(..., min_length=1, max_length=20)


class FacetVocabulariesResponse(BaseModel):
    """The zero-shot vocabulary for each classified facet, plus the
    CV-derived "color" facet which has no fixed vocabulary."""

    facets: dict[str, list[str]]


async def _run_pipeline(images: list[bytes]) -> VibeResult:
    """Shared analysis pipeline: embed → heterogeneity → classify → aggregate → compose."""
    embedder = get_embedding_service()
    embeddings = await embedder.embed_images(images)
    logger.info("Generated %d embeddings (dim=%d)", len(embeddings), len(embeddings[0]) if embeddings else 0)

    aggregator = get_aggregation_service()
    is_mixed = await aggregator.detect_heterogeneity(embeddings)
    logger.info("Heterogeneity detection: mixed=%s", is_mixed)

    non_color_facets = {k: v for k, v in FACET_VOCABULARIES.items() if k != "color"}
    per_image_facets = await embedder.classify_facets_batch(embeddings, non_color_facets)
    for i, content in enumerate(images):
        color_names = get_color_names(content)
        logger.info("Image %d color: %s", i, color_names)
        per_image_facets[i].color = color_names

    aggregated = await aggregator.aggregate(per_image_facets)
    logger.info("Aggregated facets: %s", aggregated.surviving_facets())

    phrase = aggregator.compose_phrase(aggregated)
    logger.info("Final result: phrase='%s', mixed=%s", phrase, is_mixed)

    return VibeResult(phrase=phrase, facets=aggregated, mixed=is_mixed)


@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze_images(
    files: list[UploadFile] = File(...),
):
    """Analyze a set of uploaded images and return a vibe description.

    Color facet uses classical CV (k-means + perceptual color names).
    Other facets use SigLIP2 sigmoid scoring, each gated against a
    per-facet null anchor so a facet with no real match in the image
    drops instead of forcing a guess. No mode selector — always
    domain-agnostic.
    """
    logger.info("Analyzing %d uploaded images", len(files))
    images = [await f.read() for f in files]
    vibe = await _run_pipeline(images)
    return AnalyzeResponse(vibe=vibe)


@router.post("/analyze-urls", response_model=AnalyzeResponse)
async def analyze_image_urls(body: AnalyzeUrlsRequest):
    """Analyze a set of images by URL — for service-to-service calls where
    images are already hosted (e.g. Supabase Storage) and shouldn't be
    re-uploaded as raw bytes. Same pipeline and response shape as /analyze.
    """
    logger.info("Analyzing %d images by URL", len(body.image_urls))

    images: list[bytes] = []
    async with httpx.AsyncClient(timeout=30.0) as client:
        for url in body.image_urls:
            try:
                resp = await client.get(url)
                resp.raise_for_status()
            except httpx.HTTPError as e:
                raise HTTPException(status_code=422, detail=f"Failed to fetch image URL {url!r}: {e}") from e
            images.append(resp.content)

    vibe = await _run_pipeline(images)
    return AnalyzeResponse(vibe=vibe)


@router.get("/facets", response_model=FacetVocabulariesResponse)
async def list_facet_vocabularies():
    """Return the zero-shot tag vocabulary for each facet.

    Lets a calling service validate or display facet tags (e.g. building
    filter chips) without hardcoding this service's internal vocab. The
    "color" facet is omitted here since it's populated from classical CV,
    not a fixed tag list.
    """
    return FacetVocabulariesResponse(facets=FACET_VOCABULARIES)
