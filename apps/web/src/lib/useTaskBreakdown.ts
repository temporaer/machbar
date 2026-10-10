import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Task } from "@machbar/shared";
import { api } from "./api";
import { localizedErrorMessage } from "./errorMessage";
import { useStrings } from "./strings";

/** Starts an editable proposal; this action never mutates the source task. */
export function useTaskBreakdown() {
  const navigate = useNavigate();
  const strings = useStrings();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async (task: Task, instruction: string): Promise<boolean> => {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await api.startTaskBreakdown(task.id, {
        expectedRevision: task.revision,
        ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
      });
      navigate(`/intake/${result.id}`);
      return true;
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  return { start, pending, error };
}
