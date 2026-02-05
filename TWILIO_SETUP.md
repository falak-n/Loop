# Twilio Phone Integration Setup Guide

This guide will help you connect your Loop AI Hospital Network Assistant to a Twilio phone number.

## Prerequisites

1. A Twilio account (sign up at https://www.twilio.com/try-twilio - free trial available)
2. Your server must be publicly accessible (use ngrok or similar for local development)

## Step 1: Get Twilio Credentials

1. Log in to your Twilio Console: https://console.twilio.com/
2. Find your **Account SID** and **Auth Token** on the dashboard
3. Add them to your `.env` file:
   ```
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_AUTH_TOKEN=your_auth_token_here
   ```

## Step 2: Get a Phone Number

1. In Twilio Console, go to **Phone Numbers** → **Manage** → **Buy a number**
2. Choose a number (trial accounts have limitations on which numbers you can use)
3. Purchase the number

## Step 3: Make Your Server Publicly Accessible

For local development, use **ngrok**:

1. Install ngrok: https://ngrok.com/download
2. Start your server: `npm start`
3. In another terminal, run: `ngrok http 3000`
4. Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)

## Step 4: Configure Twilio Webhook

1. In Twilio Console, go to **Phone Numbers** → **Manage** → **Active numbers**
2. Click on your phone number
3. Under **Voice & Fax**, find **A CALL COMES IN**
4. Set it to **Webhook**
5. Enter your webhook URL: `https://your-ngrok-url.ngrok.io/twilio/voice`
6. Set HTTP method to **POST**
7. Click **Save**

## Step 5: Test

1. Call your Twilio phone number
2. You should hear: "Hi, I am Loop AI, your hospital network assistant..."
3. Ask a question like: "Tell me 3 hospitals around Bangalore"
4. The AI should respond with hospital information

## Webhook Endpoints

- **Initial Call**: `POST /twilio/voice` - Handles incoming calls
- **User Response**: `POST /twilio/voice/response` - Processes speech input

## Troubleshooting

- **No response**: Check that your server is running and ngrok is active
- **"I did not understand"**: Ensure your Twilio number has speech recognition enabled
- **Webhook errors**: Check Twilio Console → Monitor → Logs → Errors for details

## Production Deployment

For production, deploy your server to a hosting service (Heroku, AWS, Railway, etc.) and use that URL instead of ngrok.
