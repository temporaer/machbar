export interface paths {
    "/api/documents/post_document/": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Upload a document for consumption.
         * @description Accepts a multipart form with the file to consume plus optional metadata overrides. Consumption happens asynchronously; the response body is the UUID of the created Paperless task, to be polled via `GET /api/tasks/?task_id={uuid}`.
         */
        post: operations["postDocument"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tasks/": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List (or look up by task_id) Paperless background tasks. */
        get: operations["listTasks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search or list documents. */
        get: operations["listDocuments"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Fetch a single document's metadata.
         * @description The standard DRF `ModelViewSet` retrieve action for `DocumentViewSet` (`documents/views.py`); returns the same `DocumentSerializer` shape as a single item of `/api/documents/`'s paginated results. Machbar uses this to project a freshly uploaded document into a `PaperlessDocumentSummary` once its consumption task has finished.
         */
        get: operations["getDocument"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/thumb/": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Fetch a document's thumbnail image. */
        get: operations["getDocumentThumbnail"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/preview/": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Fetch a document's inline preview rendition.
         * @description Serves the archived PDF when available, otherwise the original file, with a `Content-Disposition: inline` header. The actual media type depends on the stored document and is not statically knowable.
         */
        get: operations["getDocumentPreview"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/download/": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Fetch a document's original file for download.
         * @description Same file resolution as `/preview/`, but with a `Content-Disposition: attachment` header.
         */
        get: operations["getDocumentDownload"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** @description DRF's default validation error shape: a map from field name (or `non_field_errors`) to a list of human-readable messages. */
        ValidationError: {
            [key: string]: string[];
        };
        /**
         * @description Mirrors `PaperlessTask.Status` (`documents/models.py`).
         * @enum {string}
         */
        PaperlessTaskStatus: "pending" | "started" | "success" | "failure" | "revoked";
        /** @description `TaskSerializerV10` fields (API version 10, the current default; see `documents/serialisers.py`). */
        PaperlessTask: {
            id: number;
            /** Format: uuid */
            task_id: string;
            task_type?: string;
            task_type_display?: string;
            trigger_source?: string;
            trigger_source_display?: string;
            status: components["schemas"]["PaperlessTaskStatus"];
            status_display?: string;
            /** Format: date-time */
            date_created?: string | null;
            /** Format: date-time */
            date_started?: string | null;
            /** Format: date-time */
            date_done?: string | null;
            duration_seconds?: number | null;
            wait_time_seconds?: number | null;
            input_data?: {
                [key: string]: unknown;
            } | null;
            result_data?: {
                [key: string]: unknown;
            } | null;
            related_document_ids: number[];
            acknowledged: boolean;
            owner?: number | null;
        };
        /** @description Legacy task shape returned by Paperless API v9. Unlike v10, the list is unpaginated, statuses are uppercase, and the related document is a singular string field. */
        PaperlessTaskV9: {
            id: number;
            /** Format: uuid */
            task_id: string;
            task_name?: string;
            task_file_name?: string;
            /** Format: date-time */
            date_created?: string | null;
            /** Format: date-time */
            date_done?: string | null;
            type?: string;
            /** @enum {string} */
            status: "PENDING" | "STARTED" | "SUCCESS" | "FAILURE" | "REVOKED";
            result?: string | null;
            acknowledged: boolean;
            related_document?: string | null;
            owner?: number | null;
        };
        PaginatedTaskList: {
            count: number;
            next?: string | null;
            previous?: string | null;
            results: components["schemas"]["PaperlessTask"][];
        };
        /** @description Subset of `DocumentSerializer` fields (`documents/serialisers.py`) that Machbar's search results project. */
        PaperlessDocument: {
            id: number;
            title: string;
            original_file_name?: string | null;
            mime_type?: string | null;
        };
        PaginatedDocumentList: {
            count: number;
            next?: string | null;
            previous?: string | null;
            results: components["schemas"]["PaperlessDocument"][];
        };
    };
    responses: never;
    parameters: {
        documentId: number;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    postDocument: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": {
                    /** Format: binary */
                    document: string;
                    title?: string;
                    created?: string;
                    correspondent?: number;
                    document_type?: number;
                    storage_path?: number;
                    tags?: number[];
                    archive_serial_number?: number;
                };
            };
        };
        responses: {
            /** @description Consumption task created. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": string;
                };
            };
            /** @description The upload was rejected (unsupported or invalid file). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ValidationError"];
                };
            };
            /** @description The authenticated user may not add documents. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listTasks: {
        parameters: {
            query?: {
                /** @description Filter to the task with this Celery task UUID. */
                task_id?: string;
                page?: number;
                page_size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Task list. API v10 returns the paginated TaskSerializerV10 shape; API v9 returns an unpaginated array using the legacy task fields. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedTaskList"] | components["schemas"]["PaperlessTaskV9"][];
                };
            };
        };
    };
    listDocuments: {
        parameters: {
            query?: {
                /** @description Full text query (see Paperless-ngx search syntax). */
                query?: string;
                page?: number;
                page_size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Paginated document list. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedDocumentList"];
                };
            };
        };
    };
    getDocument: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["documentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The document. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaperlessDocument"];
                };
            };
            /** @description The document does not exist. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getDocumentThumbnail: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["documentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thumbnail image, always `image/webp`. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "image/webp": string;
                };
            };
            /** @description The document does not exist or has no thumbnail file. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getDocumentPreview: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["documentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Document preview file. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            /** @description The document does not exist or has no file. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getDocumentDownload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["documentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Document file. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            /** @description The document does not exist or has no file. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
