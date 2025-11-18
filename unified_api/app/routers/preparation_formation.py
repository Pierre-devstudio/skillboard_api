from fastapi import APIRouter

router = APIRouter()

@router.get("/test")
def test():
    return {"service": "preparation_formation"}
