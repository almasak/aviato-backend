-- Migration number: 0001 	 2025-12-14T17:16:27.040Z
ALTER TABLE tasks
ADD COLUMN updated_at TEXT;
