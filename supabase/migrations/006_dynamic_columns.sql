-- Add dynamic attributes and custom column headers configuration to products table
ALTER TABLE products ADD COLUMN IF NOT EXISTS custom_attributes jsonb DEFAULT '{}'::jsonb;

-- Create config table to persist user-mapped custom column names and order
CREATE TABLE IF NOT EXISTS product_column_configs (
  id text PRIMARY KEY DEFAULT 'default',
  columns jsonb NOT NULL,
  updated_at timestamptz DEFAULT now()
);

-- Enable RLS and policies
ALTER TABLE product_column_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow read on column configs" ON product_column_configs FOR SELECT USING (true);
CREATE POLICY "Allow write on column configs" ON product_column_configs FOR ALL USING (true);
