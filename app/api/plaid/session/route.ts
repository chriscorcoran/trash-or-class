import { type NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const connected = request.cookies.has('plaid_access_token')
  return Response.json({ connected })
}

export async function DELETE() {
  const response = NextResponse.json({ disconnected: true })
  response.cookies.delete('plaid_access_token')
  return response
}
