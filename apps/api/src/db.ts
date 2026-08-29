import pg from 'pg'; const {Pool}=pg;
export const pool=new Pool({connectionString:process.env.DATABASE_URL||'postgres://iotcloud:iotcloud@localhost:5432/iotcloud',max:10,ssl:process.env.DATABASE_SSL==='true'?{rejectUnauthorized:false}:undefined});
export async function migrate(){await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text UNIQUE NOT NULL,password_hash text NOT NULL,created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS projects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,name text NOT NULL,api_key text UNIQUE NOT NULL,created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS devices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,name text NOT NULL,token text UNIQUE NOT NULL,metadata jsonb NOT NULL DEFAULT '{}',last_seen timestamptz,online boolean NOT NULL DEFAULT false,created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS workflows(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,name text NOT NULL,definition jsonb NOT NULL,enabled boolean NOT NULL DEFAULT false,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS credentials(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,name text NOT NULL,kind text NOT NULL,secret text NOT NULL,created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS workflow_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,status text NOT NULL,trigger_event jsonb,started_at timestamptz DEFAULT now(),finished_at timestamptz,error text);
CREATE TABLE IF NOT EXISTS telemetry(id bigserial PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,topic text NOT NULL,payload jsonb NOT NULL,created_at timestamptz DEFAULT now());
CREATE INDEX IF NOT EXISTS telemetry_project_device_idx ON telemetry(project_id,device_id,created_at DESC);
CREATE INDEX IF NOT EXISTS workflows_project_idx ON workflows(project_id,enabled);
CREATE INDEX IF NOT EXISTS devices_token_idx ON devices(token);`)}
