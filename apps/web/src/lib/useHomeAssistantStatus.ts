import { api } from "./api";
import { useAsync } from "./useAsync";

export function useHomeAssistantStatus() {
  return useAsync(() => api.getHomeAssistantStatus(), []);
}
