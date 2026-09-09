"""
Origami OCR Service — PaddleOCR-VL-1.6 interface.
Served separately; called via AI Gateway task=ocr.
"""
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Origami OCR Service")


class OcrRequest(BaseModel):
    image_base64: str


class OcrResponse(BaseModel):
    text: str
    regions: list[dict]
    model: str = "PaddleOCR-VL-1.6"
    available: bool = False


@app.get("/health")
def health():
    return {"status": "ok", "service": "ocr", "model": "PaddleOCR-VL-1.6"}


@app.post("/ocr", response_model=OcrResponse)
def ocr(request: OcrRequest):
    return OcrResponse(
        text="",
        regions=[],
        available=False,
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3003)
