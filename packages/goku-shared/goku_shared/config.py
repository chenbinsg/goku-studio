from pydantic_settings import BaseSettings


class SharedSettings(BaseSettings):
    DATABASE_URL: str = "sqlite:///./goku.db"
    SECRET_KEY: str = "change-me"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30

    model_config = {"env_file": ".env", "extra": "ignore"}
