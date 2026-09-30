import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir:'./e2e', timeout:120000, workers:1, retries:0,
  use:{actionTimeout:10000,baseURL:'http://127.0.0.1:18088', viewport:{width:1440,height:900}, screenshot:'only-on-failure', trace:'retain-on-failure'},
  webServer:{command:'python3 -m uvicorn app.main:app --host 127.0.0.1 --port 18088 --log-level warning',cwd:'..',url:'http://127.0.0.1:18088/api/health',reuseExistingServer:false,timeout:30000},
})
