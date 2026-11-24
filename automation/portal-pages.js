function portalPages(root){const pages=new Set(),listeners=[];const attach=page=>{if(pages.has(page))return;pages.add(page);const popup=p=>attach(p);page.on('popup',popup);listeners.push(()=>page.off('popup',popup));};attach(root);return {pages:()=>[...pages].filter(p=>!p.isClosed()),dispose:()=>listeners.forEach(fn=>fn())};}
module.exports={portalPages};
