import { useState } from "react";
import {
  createCalendarExportFile,
  type CalendarExportItem,
} from "../lib/calendarExport";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { IconActionButton } from "./IconActionButton";

export function CalendarExportButton({
  item,
  showStatus = true,
  onStatusChange,
}: {
  item: Omit<CalendarExportItem, "dueDate"> & { dueDate: string | null };
  showStatus?: boolean;
  onStatusChange?: (status: string | null) => void;
}) {
  const strings = useStrings();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!item.dueDate) return null;
  const dueDate = item.dueDate;

  const updateStatus = (nextStatus: string | null) => {
    setStatus(nextStatus);
    onStatusChange?.(nextStatus);
  };

  const download = (file: File) => {
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const exportCalendar = async () => {
    if (busy) return;
    setBusy(true);
    updateStatus(null);
    try {
      const file = createCalendarExportFile({
        ...item,
        dueDate,
      });
      const shareData = { files: [file], title: item.title };
      if (
        typeof navigator.share === "function" &&
        typeof navigator.canShare === "function" &&
        navigator.canShare(shareData)
      ) {
        await navigator.share(shareData);
        updateStatus(strings.calendarExportShared);
      } else {
        download(file);
        updateStatus(strings.calendarExportDownloaded);
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      updateStatus(localizedErrorMessage(cause, strings));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="native-share-control">
      <IconActionButton
        kind="schedule"
        label={strings.addToCalendar}
        disabled={busy}
        onClick={() => void exportCalendar()}
      />
      {showStatus && status ? (
        <span className="text-muted native-share-status" role="status">
          {status}
        </span>
      ) : null}
    </span>
  );
}
