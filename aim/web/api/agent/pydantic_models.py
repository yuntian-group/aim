from typing import Optional

from pydantic import BaseModel


class AgentCommandIn(BaseModel):
    type: str
    payload: str
    timeout: Optional[int] = 120


class AgentCommandOut(BaseModel):
    id: str
    status: str
    result: Optional[str] = None
    error: Optional[str] = None
