#!/bin/bash

# 1. Create venv if it doesn't exist
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

# 2. Activate venv
echo "Activating virtual environment..."
source venv/bin/activate

# 3. Install dependencies
echo "Installing dependencies..."
pip install -r requirements.txt

# 4. Run the server
echo "Starting server..."
uvicorn app:app --reload --host 0.0.0.0 --port 8000