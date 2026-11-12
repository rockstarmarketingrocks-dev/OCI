import { createApp } from './app.js';
const port = Number(process.env.PORT || 3000);
const { app, ctx } = await createApp();
app.listen(port, () => console.log(`Ranklight listening on http://localhost:${port}`));
ctx.events.emit('server:started', { port });
