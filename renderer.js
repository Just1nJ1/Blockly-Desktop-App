// Blockly workspace
let workspace;

// Server URL - use 127.0.0.1 to avoid DNS resolution issues
const SERVER_URL = 'http://127.0.0.1:5000';

// Cache for function signatures to avoid repeated API calls
const functionCache = new Map();

// Initialize Blockly when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  initCustomBlocks();
  initPythonGenerator();
  initBlockly();
  setupCustomPrompts();
});

// Initialize custom blocks
function initCustomBlocks() {
  // Define the dynamic function call block
  Blockly.Blocks['function_call'] = {
    init: function() {
      // Store reference to the block for use in validator
      const block = this;

      // Create validator function that has access to the block
      const validator = function(newValue) {
        // Debounce the API call
        if (block.validateTimeout_) {
          clearTimeout(block.validateTimeout_);
        }

        block.validateTimeout_ = setTimeout(() => {
          block.updateFunctionInfo(newValue);
        }, 300);

        return newValue;
      };

      this.appendDummyInput('FUNCTION_NAME')
          .appendField('call')
          .appendField(new Blockly.FieldTextInput('print', validator), 'FUNC_NAME');

      this.setInputsInline(false);
      this.setOutput(true, null);
      this.setColour(290);
      this.setTooltip('Call a Python function. Enter the function name to see its parameters.');
      this.setHelpUrl('');

      // Store function info
      this.functionInfo_ = null;
    },

    // Fetch function info from server and update block
    updateFunctionInfo: async function(funcName) {
      if (!funcName || funcName.trim() === '') {
        return;
      }

      // Check cache first
      if (functionCache.has(funcName)) {
        this.applyFunctionInfo(functionCache.get(funcName));
        return;
      }

      try {
        const response = await fetch(`${SERVER_URL}/inspect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ function: funcName })
        });

        const info = await response.json();

        if (info.success) {
          functionCache.set(funcName, info);
          this.applyFunctionInfo(info);
        } else {
          // Show error in tooltip
          this.setTooltip(`Error: ${info.error}`);
        }
      } catch (error) {
        console.error('Failed to fetch function info:', error);
        this.setTooltip(`Failed to fetch function info: ${error.message}`);
      }
    },

    // Apply function info to update the block's inputs
    applyFunctionInfo: function(info) {
      this.functionInfo_ = info;

      // Update tooltip with docstring (first 500 chars)
      const docPreview = info.docstring.length > 500
        ? info.docstring.substring(0, 500) + '...'
        : info.docstring;
      this.setTooltip(docPreview);

      // Save current input values before rebuilding
      const oldValues = {};
      if (this.paramInputs_) {
        for (const paramName of this.paramInputs_) {
          const input = this.getInput(`PARAM_${paramName}`);
          if (input && input.connection && input.connection.targetBlock()) {
            oldValues[paramName] = input.connection.targetBlock();
          }
        }
      }

      // Remove all parameter inputs
      const inputNames = this.inputList.map(i => i.name).filter(n => n && n.startsWith('PARAM_'));
      for (const name of inputNames) {
        this.removeInput(name);
      }

      // Create new parameter inputs
      this.paramInputs_ = [];

      for (const param of info.parameters) {
        const paramName = param.name;
        this.paramInputs_.push(paramName);

        // Create input label
        let labelText = paramName;
        if (param.has_default) {
          labelText += ` = ${param.default}`;
        }
        if (param.is_varargs) {
          labelText = '*' + paramName;
        } else if (param.is_varkwargs) {
          labelText = '**' + paramName;
        }

        // Create the input
        const input = this.appendValueInput(`PARAM_${paramName}`)
            .setCheck(null)
            .appendField(labelText);

        // Restore old value if exists
        if (oldValues[paramName]) {
          input.connection.connect(oldValues[paramName].outputConnection);
        }
      }

      // Update the block's shape
      this.render();
    },

    // Save extra state for serialization
    mutationToDom: function() {
      const container = document.createElement('mutation');
      container.setAttribute('func_name', this.getFieldValue('FUNC_NAME'));

      if (this.functionInfo_) {
        container.setAttribute('params', JSON.stringify(this.functionInfo_.parameters.map(p => p.name)));
      }

      return container;
    },

    // Load extra state from serialization
    domToMutation: function(xmlElement) {
      const funcName = xmlElement.getAttribute('func_name');
      if (funcName) {
        // Trigger async update
        this.updateFunctionInfo(funcName);
      }
    }
  };
}

// Python code generator for the function call block
// Define it as a separate function and register it after Blockly loads
function initPythonGenerator() {
  if (!Blockly.Python) {
    console.error('Blockly.Python not available');
    return;
  }

  // In newer Blockly versions, generators use forBlock namespace
  // In older versions, they're directly on the generator object
  const generatorTarget = Blockly.Python.forBlock || Blockly.Python;

  generatorTarget['function_call'] = function(block) {
    const funcName = block.getFieldValue('FUNC_NAME');
    const funcInfo = block.functionInfo_;

    if (!funcInfo || !funcInfo.parameters || funcInfo.parameters.length === 0) {
      // No parameters - just call the function
      return [`${funcName}()`, Blockly.Python.ORDER_FUNCTION_CALL];
    }

    const args = [];

    for (const param of funcInfo.parameters) {
      const inputName = `PARAM_${param.name}`;
      const inputValue = Blockly.Python.valueToCode(block, inputName, Blockly.Python.ORDER_NONE);

      if (inputValue) {
        if (param.is_varargs) {
          // For *args, just pass the value (assuming it's a tuple/list)
          args.push(`*${inputValue}`);
        } else if (param.is_varkwargs) {
          // For **kwargs, just pass the value (assuming it's a dict)
          args.push(`**${inputValue}`);
        } else if (param.is_keyword_only || param.has_default) {
          // Use keyword argument
          args.push(`${param.name}=${inputValue}`);
        } else {
          // Positional argument
          args.push(inputValue);
        }
      } else if (!param.has_default && !param.is_varargs && !param.is_varkwargs) {
        // Required parameter without value - use None as placeholder
        args.push('None');
      }
      // If has default and no value provided, skip it (use default)
    }

    const code = `${funcName}(${args.join(', ')})`;
    return [code, Blockly.Python.ORDER_FUNCTION_CALL];
  };
}

// Override Blockly's prompt with custom implementation for Electron
function setupCustomPrompts() {
  // Override the default prompt function used by Blockly
  Blockly.dialog.setPrompt(function(message, defaultValue, callback) {
    // Create a custom modal dialog
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 10000;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      min-width: 300px;
    `;

    const label = document.createElement('label');
    label.textContent = message;
    label.style.cssText = 'display: block; margin-bottom: 10px; font-weight: bold;';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultValue || '';
    input.style.cssText = `
      width: 100%;
      padding: 8px;
      border: 1px solid #ccc;
      border-radius: 4px;
      box-sizing: border-box;
      margin-bottom: 15px;
    `;

    const buttonContainer = document.createElement('div');
    buttonContainer.style.cssText = 'display: flex; justify-content: flex-end; gap: 10px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = `
      padding: 8px 16px;
      background: #ccc;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    `;

    const okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
    okBtn.style.cssText = `
      padding: 8px 16px;
      background: #2196F3;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    `;

    cancelBtn.onclick = () => {
      document.body.removeChild(modal);
      callback(null);
    };

    okBtn.onclick = () => {
      document.body.removeChild(modal);
      callback(input.value);
    };

    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        document.body.removeChild(modal);
        callback(input.value);
      }
    });

    buttonContainer.appendChild(cancelBtn);
    buttonContainer.appendChild(okBtn);
    dialog.appendChild(label);
    dialog.appendChild(input);
    dialog.appendChild(buttonContainer);
    modal.appendChild(dialog);
    document.body.appendChild(modal);

    input.focus();
    input.select();
  });

  // Also override confirm for delete operations
  Blockly.dialog.setConfirm(function(message, callback) {
    callback(confirm(message));
  });

  // Override alert
  Blockly.dialog.setAlert(function(message, callback) {
    alert(message);
    callback();
  });
}

function initBlockly() {
  // Define toolbox with basic blocks
  const toolbox = {
    kind: 'categoryToolbox',
    contents: [
      {
        kind: 'category',
        name: 'Logic',
        colour: '#5C81A6',
        contents: [
          { kind: 'block', type: 'controls_if' },
          { kind: 'block', type: 'logic_compare' },
          { kind: 'block', type: 'logic_operation' },
          { kind: 'block', type: 'logic_negate' },
          { kind: 'block', type: 'logic_boolean' },
        ],
      },
      {
        kind: 'category',
        name: 'Loops',
        colour: '#5CA65C',
        contents: [
          { kind: 'block', type: 'controls_repeat_ext' },
          { kind: 'block', type: 'controls_whileUntil' },
          { kind: 'block', type: 'controls_for' },
          { kind: 'block', type: 'controls_forEach' },
          { kind: 'block', type: 'controls_flow_statements' },
        ],
      },
      {
        kind: 'category',
        name: 'Math',
        colour: '#5C68A6',
        contents: [
          { kind: 'block', type: 'math_number' },
          { kind: 'block', type: 'math_arithmetic' },
          { kind: 'block', type: 'math_single' },
          { kind: 'block', type: 'math_trig' },
          { kind: 'block', type: 'math_constant' },
          { kind: 'block', type: 'math_number_property' },
          { kind: 'block', type: 'math_round' },
          { kind: 'block', type: 'math_on_list' },
          { kind: 'block', type: 'math_modulo' },
          { kind: 'block', type: 'math_constrain' },
          { kind: 'block', type: 'math_random_int' },
          { kind: 'block', type: 'math_random_float' },
        ],
      },
      {
        kind: 'category',
        name: 'Text',
        colour: '#A65C81',
        contents: [
          { kind: 'block', type: 'text' },
          { kind: 'block', type: 'text_join' },
          { kind: 'block', type: 'text_append' },
          { kind: 'block', type: 'text_length' },
          { kind: 'block', type: 'text_isEmpty' },
          { kind: 'block', type: 'text_indexOf' },
          { kind: 'block', type: 'text_charAt' },
          { kind: 'block', type: 'text_getSubstring' },
          { kind: 'block', type: 'text_changeCase' },
          { kind: 'block', type: 'text_trim' },
          { kind: 'block', type: 'text_print' },
          { kind: 'block', type: 'text_prompt_ext' },
        ],
      },
      {
        kind: 'category',
        name: 'Lists',
        colour: '#A65C5C',
        contents: [
          { kind: 'block', type: 'lists_create_with' },
          { kind: 'block', type: 'lists_create_with' },
          { kind: 'block', type: 'lists_repeat' },
          { kind: 'block', type: 'lists_length' },
          { kind: 'block', type: 'lists_isEmpty' },
          { kind: 'block', type: 'lists_indexOf' },
          { kind: 'block', type: 'lists_getIndex' },
          { kind: 'block', type: 'lists_setIndex' },
          { kind: 'block', type: 'lists_getSublist' },
          { kind: 'block', type: 'lists_split' },
          { kind: 'block', type: 'lists_sort' },
        ],
      },
      {
        kind: 'category',
        name: 'Variables',
        colour: '#A65CA6',
        custom: 'VARIABLE',
      },
      {
        kind: 'category',
        name: 'Functions',
        colour: '#9A5CA6',
        custom: 'PROCEDURE',
      },
      {
        kind: 'category',
        name: 'Python',
        colour: '#4B8BBE',
        contents: [
          { kind: 'block', type: 'function_call' },
        ],
      },
    ],
  };

  // Inject Blockly
  workspace = Blockly.inject('blocklyDiv', {
    toolbox: toolbox,
    grid: {
      spacing: 20,
      length: 3,
      colour: '#ccc',
      snap: true,
    },
    trashcan: true,
    zoom: {
      controls: true,
      wheel: true,
      startScale: 1.0,
      maxScale: 3,
      minScale: 0.3,
      scaleSpeed: 1.2,
    },
  });

  // Update code preview on block change
  workspace.addChangeListener(updateCodePreview);
}

function updateCodePreview() {
  const code = Blockly.Python.workspaceToCode(workspace);
  document.getElementById('code-preview').textContent = code;
}

async function runCode() {
  const runBtn = document.getElementById('runBtn');
  const outputContent = document.getElementById('output-content');

  // Disable button during execution
  runBtn.disabled = true;
  runBtn.textContent = '⏳ Running...';

  // Clear previous output
  outputContent.innerHTML = '';

  try {
    // First check if server is healthy
    try {
      const healthCheck = await fetch(`${SERVER_URL}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      if (!healthCheck.ok) {
        throw new Error('Server health check failed');
      }
    } catch (healthError) {
      appendOutput('Python server is not running. Please restart the application.', 'error');
      return;
    }

    // Generate Python code from blocks
    const pythonCode = Blockly.Python.workspaceToCode(workspace);

    if (!pythonCode.trim()) {
      appendOutput('No code to execute. Add some blocks first!', 'error');
      return;
    }

    // Send code to Python server
    const response = await fetch(`${SERVER_URL}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code: pythonCode }),
      signal: AbortSignal.timeout(30000) // 30 second timeout
    });

    // Check if response is OK before parsing JSON
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Server error (${response.status}): ${text || 'Unknown error'}`);
    }

    // Try to parse JSON response
    let result;
    try {
      const text = await response.text();
      if (!text) {
        throw new Error('Empty response from server');
      }
      result = JSON.parse(text);
    } catch (parseError) {
      throw new Error(`Invalid JSON response: ${parseError.message}`);
    }

    if (result.success) {
      // Display output
      if (result.stdout) {
        appendOutput(result.stdout, 'stdout');
      }
      if (result.result !== null && result.result !== undefined) {
        appendOutput(`Result: ${result.result}`, 'result');
      }
      if (result.stderr) {
        appendOutput(result.stderr, 'stderr');
      }
    } else {
      appendOutput(`Error: ${result.error}`, 'error');
      if (result.traceback) {
        appendOutput(result.traceback, 'stderr');
      }
    }
  } catch (error) {
    appendOutput(`Connection Error: ${error.message}`, 'error');
    appendOutput('Make sure the Python server is running.', 'stderr');
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = '▶ Run Code';
  }
}

function appendOutput(text, type) {
  const outputContent = document.getElementById('output-content');
  const line = document.createElement('div');
  line.className = `output-line output-${type}`;
  line.textContent = text;
  outputContent.appendChild(line);
  outputContent.scrollTop = outputContent.scrollHeight;
}

function clearWorkspace() {
  if (confirm('Are you sure you want to clear the workspace?')) {
    workspace.clear();
    updateCodePreview();
    document.getElementById('output-content').innerHTML = '';
  }
}

function exportBlocks() {
  const xml = Blockly.Xml.workspaceToDom(workspace);
  const xmlText = Blockly.Xml.domToText(xml);
  
  // Create a blob and download link
  const blob = new Blob([xmlText], { type: 'text/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'blockly_workspace.xml';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importBlocks() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xml';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const xml = Blockly.utils.xml.textToDom(event.target.result);
          workspace.clear();
          Blockly.Xml.domToWorkspace(xml, workspace);
          updateCodePreview();
        } catch (err) {
          alert('Error loading file: ' + err.message);
        }
      };
      reader.readAsText(file);
    }
  };
  input.click();
}