document.querySelector('#login').addEventListener('submit', async event => {
  event.preventDefault();
  const result = document.querySelector('#result');
  try {
    const response = await fetch('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: document.querySelector('#token').value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Sign in failed');
    location.assign('/runtime/connection');
  } catch (error) { result.textContent = error.message; }
});
