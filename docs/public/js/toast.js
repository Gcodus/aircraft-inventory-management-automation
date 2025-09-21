// toast.js - simple toast notifications

(function () {
  // Create toast container 
  if (!document.getElementById('toast')) {
    const div = document.createElement('div');
    div.id = 'toast';
    document.body.appendChild(div);
  }

  // toast CSS only once
  if (!document.getElementById('toast-style')) {
    const style = document.createElement('style');
    style.id = 'toast-style';
    style.textContent = `
      #toast {
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: #1e293b;
        color: #fff;
        padding: 12px 16px;
        border-radius: 8px;
        font-size: 0.9rem;
        box-shadow: 0 4px 8px rgba(0,0,0,0.15);
        opacity: 0;
        transform: translateY(20px);
        transition: opacity 0.3s ease, transform 0.3s ease;
        z-index: 9999;
        pointer-events: none;
      }
      #toast.show {
        opacity: 1;
        transform: translateY(0);
      }
      #toast.success { background: #16a34a; } /* green */
      #toast.error { background: #dc2626; }   /* red */
      #toast.info { background: #2563eb; }    /* blue */
    `;
    document.head.appendChild(style);
  }

  // global func
  window.showToast = function (message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = ''; // reset class
    toast.classList.add('show', type);
    setTimeout(() => toast.classList.remove('show'), 2500);
  };
})();
