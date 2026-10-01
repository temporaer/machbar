"""Constants for the Machbar integration."""

DOMAIN = "machbar"
CONF_ORIGIN = "origin"
CONF_PAIRING_CODE = "pairing_code"
CONF_TOKEN = "token"
CONF_INSTANCE_ID = "instanceId"
CONF_PROTOCOL_VERSION = "protocolVersion"

PROTOCOL_VERSION = 3
PAIR_PATH = "/api/integrations/home-assistant/pair"
CONTEXT_PATH = "/api/integrations/home-assistant/context"
SYNC_TASK_PATH = "/api/integrations/home-assistant/tasks/sync"
REQUESTS_NEXT_PATH = "/api/integrations/home-assistant/requests/next"
REQUEST_COMPLETE_PATH = "/api/integrations/home-assistant/requests/{id}/complete"
ATTACHMENT_PATH = "/api/integrations/home-assistant/intake/{job}/attachments/{att}"
CONF_AI_TASK_ENTITY = "ai_task_entity_id"
CONF_CALENDAR_ENTITY = "calendar_entity_id"
PUSH_DELAY_SECONDS = 0.5
LONG_POLL_SECONDS = 25
BACKOFF_INITIAL = 1
BACKOFF_MAX = 60
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
CORRELATION_PREFIX = "machbar-ref:"
