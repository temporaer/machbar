import type {
  NotificationKind,
  PushLocale,
  PushNotificationAction,
} from "@machbar/shared";

interface NotificationCopy {
  title: string;
  body: (actorName: string | null, entityTitle: string) => string;
}

interface NotificationCatalog {
  notifications: Record<NotificationKind, NotificationCopy>;
  actions: Record<PushNotificationAction, string>;
}

const catalogs: Record<PushLocale, NotificationCatalog> = {
  de: {
    notifications: {
      task_assigned: {
        title: "Jetzt machbar",
        body: (actor, title) =>
          actor
            ? `${actor} hat dir „${title}“ zugewiesen.`
            : `Dir wurde „${title}“ zugewiesen.`,
      },
      project_assigned: {
        title: "Jetzt machbar",
        body: (actor, title) =>
          actor
            ? `${actor} hat dir das Projekt „${title}“ zugewiesen.`
            : `Dir wurde das Projekt „${title}“ zugewiesen.`,
      },
      task_reminder: {
        title: "Jetzt machbar",
        body: (_actor, title) => `Erinnerung: ${title}`,
      },
    },
    actions: {
      today: "Heute",
      open: "Öffnen",
      complete: "Erledigt",
    },
  },
  en: {
    notifications: {
      task_assigned: {
        title: "Ready to do",
        body: (actor, title) =>
          actor
            ? `${actor} assigned “${title}” to you.`
            : `“${title}” was assigned to you.`,
      },
      project_assigned: {
        title: "Ready to do",
        body: (actor, title) =>
          actor
            ? `${actor} assigned the project “${title}” to you.`
            : `The project “${title}” was assigned to you.`,
      },
      task_reminder: {
        title: "Ready to do",
        body: (_actor, title) => `Reminder: ${title}`,
      },
    },
    actions: {
      today: "Today",
      open: "Open",
      complete: "Done",
    },
  },
};

export function notificationCatalog(locale: PushLocale): NotificationCatalog {
  return catalogs[locale];
}
