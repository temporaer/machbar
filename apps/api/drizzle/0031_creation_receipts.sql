CREATE TABLE creation_receipts (
  request_key TEXT NOT NULL,
  route TEXT NOT NULL,
  viewer_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  work_item_id INTEGER REFERENCES work_items(id) ON DELETE SET NULL,
  PRIMARY KEY (request_key, route, viewer_key)
);
