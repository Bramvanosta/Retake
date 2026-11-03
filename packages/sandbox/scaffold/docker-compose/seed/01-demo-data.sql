-- Demo data of the sandbox (written by `retake sandbox init`): replace it with your application's, or with an `exec`
-- seed step that runs its own seed command. It runs in one transaction on database `main` of sandbox.yaml; with the
-- snapshot strategy a copy of the result is restored before every take. Plain SQL statements only: a pg_dump file
-- must be made with `pg_dump --inserts` (or loaded by an `exec` step running psql inside the db container).
DROP TABLE IF EXISTS demo_customers;
CREATE TABLE demo_customers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  city text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT '2026-11-02 10:24:00+00'
);
INSERT INTO demo_customers (name, city) VALUES
  ('Willow Street Bakery', 'Riverton'),
  ('Copper Kettle Cafe', 'Lakeside'),
  ('Northgate Grocers', 'Hillcrest'),
  ('Blue Fern Florist', 'Riverton'),
  ('Harbor Lane Deli', 'Bayview');
