@echo off
setlocal
npm install
pip install -r requirements.txt
echo.
echo Start web server with: npm run server
echo Start desktop app with: npm start
