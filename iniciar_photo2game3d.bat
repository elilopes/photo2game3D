@echo off
setlocal EnableExtensions
title Photo2Game3D - AI Reconstruction

cd /d "%~dp0"

echo.
echo ==========================================================
echo       Photo2Game3D - Motores Image-to-3D
echo ==========================================================
echo.
echo [1] LOCAL  - InstantMesh e Hunyuan3D executados localmente
echo [2] NUVEM  - APIs remotas para InstantMesh e Hunyuan3D
echo [3] SAIR
echo.
choice /c 123 /n /m "Selecione [1-3]: "
if errorlevel 3 goto :eof
if errorlevel 2 goto cloud
if errorlevel 1 goto local

:local
set "PHOTO2GAME_AI_MODE=local"
set "PHOTO2GAME_3D_MODE=local"
set "HF_TOKEN="
echo.
echo --- InstantMesh local ---
echo Informe a pasta do repositorio oficial TencentARC/InstantMesh.
set /p "INSTANTMESH_DIR=Pasta InstantMesh [models\InstantMesh]: "
if not defined INSTANTMESH_DIR set "INSTANTMESH_DIR=models\InstantMesh"
set /p "INSTANTMESH_PYTHON=Python do ambiente InstantMesh [python]: "
if not defined INSTANTMESH_PYTHON set "INSTANTMESH_PYTHON=python"

echo.
echo --- Hunyuan3D local ---
echo O servidor Hunyuan3D deve estar instalado em ambiente Python proprio.
set /p "HUNYUAN3D_DIR=Pasta do repositorio Hunyuan3D (Enter para nao iniciar): "
if defined HUNYUAN3D_DIR (
  set /p "HUNYUAN3D_PYTHON=Python do ambiente Hunyuan3D [python]: "
  if not defined HUNYUAN3D_PYTHON set "HUNYUAN3D_PYTHON=python"
  if exist "%HUNYUAN3D_DIR%\api_server.py" (
    echo Iniciando API local Hunyuan3D na porta 8081...
    start "Hunyuan3D API" cmd /k "cd /d ""%HUNYUAN3D_DIR%"" && ""%HUNYUAN3D_PYTHON%"" api_server.py --host 127.0.0.1 --port 8081 --enable_tex"
    set "HUNYUAN3D_API_URL=http://127.0.0.1:8081/generate"
  ) else (
    echo AVISO: api_server.py nao encontrado. Configure HUNYUAN3D_API_URL manualmente.
  )
)
goto install

:cloud
set "PHOTO2GAME_AI_MODE=cloud"
set "PHOTO2GAME_3D_MODE=cloud"
echo.
echo --- Hunyuan3D na nuvem ---
set /p "HUNYUAN3D_API_URL=URL completa do endpoint Hunyuan3D /generate: "
if not defined HUNYUAN3D_API_URL (
  echo ERRO: informe a URL do Hunyuan3D.
  pause
  exit /b 1
)
set /p "HUNYUAN3D_API_TOKEN=Token Bearer Hunyuan3D (Enter se nao necessario): "
echo.
echo --- InstantMesh na nuvem ---
echo Informe uma API compativel: POST multipart/form-data campo image; resposta GLB binaria.
set /p "INSTANTMESH_API_URL=URL do endpoint InstantMesh: "
set /p "INSTANTMESH_API_TOKEN=Token Bearer InstantMesh (Enter se nao necessario): "
goto install

:install
echo.
echo Instalando/verificando dependencias do Photo2Game3D...
python -m pip install --upgrade pip
if errorlevel 1 goto error
python -m pip install -r requirements.txt
if errorlevel 1 goto error

echo.
echo ==========================================================
echo Modo IA: %PHOTO2GAME_AI_MODE%
echo Modo Image-to-3D: %PHOTO2GAME_3D_MODE%
echo ==========================================================
echo.
echo ATENCAO:
echo - InstantMesh local exige GPU CUDA e ambiente proprio configurado.
echo - Hunyuan3D local usa o ambiente proprio e API na porta 8081.
echo - Na nuvem, os endpoints devem estar acessiveis por HTTP/HTTPS.
echo - Se um motor falhar, o Photo2Game3D usa os fallbacks existentes.
echo.
python server.py
set "SERVER_EXIT=%ERRORLEVEL%"
echo.
echo O servidor foi encerrado (codigo %SERVER_EXIT%).
pause
exit /b %SERVER_EXIT%

:error
echo.
echo ERRO: falha ao instalar dependencias do Photo2Game3D.
echo Verifique Python, internet e tente novamente.
pause
exit /b 1
