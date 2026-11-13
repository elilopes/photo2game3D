@echo off
setlocal EnableExtensions
title Photo2Game3D - AI Reconstruction

cd /d "%~dp0"

echo.
echo ==========================================================
echo             Photo2Game3D - Configuracao de IA
echo ==========================================================
echo.
echo Escolha como a segmentacao e reconstrucao da fachada
echo sera executada:
echo.
echo   [1] LOCAL  - modelos executados neste computador
echo   [2] NUVEM  - segmentacao via Hugging Face Inference API
echo   [3] SAIR
echo.
choice /c 123 /n /m "Selecione [1-3]: "

if errorlevel 3 goto :eof
if errorlevel 2 goto cloud
if errorlevel 1 goto local

:local
set "PHOTO2GAME_AI_MODE=local"
set "HF_TOKEN="
echo.
echo Modo LOCAL selecionado.
echo Os pesos dos modelos serao baixados na primeira execucao.
goto install

:cloud
set "PHOTO2GAME_AI_MODE=cloud"
echo.
echo Modo NUVEM selecionado.
echo Crie um token em https://huggingface.co/settings/tokens
echo O token sera usado somente nesta janela e nao sera salvo no arquivo.
set /p "HF_TOKEN=Informe seu Hugging Face token (hf_...): "
if not defined HF_TOKEN (
    echo.
    echo ERRO: nenhum token foi informado.
    pause
    exit /b 1
)

:install
echo.
echo [1/2] Instalando/verificando dependencias...
python -m pip install --upgrade pip
if errorlevel 1 goto error
python -m pip install -r requirements.txt
if errorlevel 1 goto error

echo.
echo [2/2] Iniciando Photo2Game3D...
echo Modo de IA: %PHOTO2GAME_AI_MODE%
echo.
python server.py
set "SERVER_EXIT=%ERRORLEVEL%"
echo.
echo O servidor foi encerrado (codigo %SERVER_EXIT%).
pause
exit /b %SERVER_EXIT%

:error
echo.
echo ERRO: falha ao instalar dependencias.
echo Verifique a instalacao do Python, a conexao com a internet
echo e tente executar novamente.
pause
exit /b 1
