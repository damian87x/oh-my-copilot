export const port=Number(process.env.PORT)
if(Number.isNaN(port))throw new Error('no port')
