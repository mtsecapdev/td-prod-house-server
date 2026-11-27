-- The image skill (ComfyUI) is gone: the chat makes slide decks and training documents. Generated images and
-- infographics, and the image-only statuses ('prompt_ready', 'generating'), can no longer exist.
DELETE FROM generations WHERE type NOT IN ('deck', 'doc');
DELETE FROM assets WHERE kind = 'image';
ALTER TABLE generations DROP CONSTRAINT IF EXISTS generations_type_check;
ALTER TABLE generations ADD CONSTRAINT generations_type_check CHECK (type IN ('deck', 'doc'));
UPDATE generations SET status = 'pending' WHERE status IN ('prompt_ready', 'generating');
ALTER TABLE generations DROP CONSTRAINT IF EXISTS generations_status_check;
ALTER TABLE generations ADD CONSTRAINT generations_status_check
  CHECK (status IN ('pending', 'outline_ready', 'writing', 'done', 'failed'));
