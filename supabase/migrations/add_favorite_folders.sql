-- Create favorite_folders table
CREATE TABLE favorite_folders (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id text NOT NULL,
  name text NOT NULL,
  color text,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX idx_favorite_folders_user_id ON favorite_folders(user_id);

-- Add folder_id to favorite_wallets
ALTER TABLE favorite_wallets
  ADD COLUMN folder_id uuid REFERENCES favorite_folders(id) ON DELETE SET NULL;

CREATE INDEX idx_favorite_wallets_folder_id ON favorite_wallets(folder_id);
