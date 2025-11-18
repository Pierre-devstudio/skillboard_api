from fastapi import APIRouter

router = APIRouter()

@router.get("/test")
def test():
    return {"service": "presence_formation"}
