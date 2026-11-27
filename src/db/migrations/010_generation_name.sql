-- A name the user gave a deck/document. Without one, the name is its title slide's / title page's title.
ALTER TABLE generations ADD COLUMN IF NOT EXISTS name TEXT;
